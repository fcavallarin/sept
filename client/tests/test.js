import { canonicalJson, serializeBin } from "@sept-protocol/core";
import { BaseSeptApp } from "./base_app.js";
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, mkdir, cp } from 'node:fs/promises';
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs"

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_PORT = 18787
const NUM_DEVICES = 4
let server
const serverOutput = []

function assert(cond, err) {
  if (!cond) {
    throw new Error(err)
  }
}

async function sleep(ms) {
  await new Promise(r => setTimeout(r, ms))
}

class SeptTest {
  async init() {
    const dataDir = path.resolve(__dirname, "data")
    const serverDir = path.resolve(dataDir, "test-server")
    await rm(dataDir, { recursive: true, force: true });
    await mkdir(dataDir, { recursive: true });

    execFileSync(
      "npm",
      ["run", "scaffold:server", "--", "test", serverDir],
      { stdio: "inherit", cwd: path.resolve(__dirname, "..", "..") }
    )

    const packageJson = path.resolve(serverDir, "package.json")
    const packageJsonCont = JSON.parse(fs.readFileSync(packageJson, "utf-8"))
    packageJsonCont.dependencies['@sept-protocol/server'] = "../../../server"
    fs.writeFileSync(packageJson, JSON.stringify(packageJsonCont), "utf-8")

    // test_create_network_atomic creates two more networks (one orphaned by a
    // simulated local failure) and then expects the relay to refuse a fourth.
    const serverIndex = path.resolve(serverDir, "src", "index.js")
    const serverIndexCont = fs.readFileSync(serverIndex, "utf-8")
    assert(serverIndexCont.includes("maxNetworks: 1"), "Unexpected scaffolded server: maxNetworks not found")
    fs.writeFileSync(serverIndex, serverIndexCont.replace("maxNetworks: 1", "maxNetworks: 3"), "utf-8")

    execFileSync(
      "npm", ["install"],
      { stdio: "inherit", cwd: serverDir }
    )
    const wranglerConf = path.resolve(serverDir, "wrangler.jsonc")
    await cp(path.resolve(__dirname, "wrangler.jsonc"), wranglerConf)

    execFileSync(
      "npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local"],
      { stdio: ["ignore", "pipe", "pipe"], cwd: serverDir }
    )
    server = spawn(
      "npx",
      ["wrangler", "dev", "--config", wranglerConf, "--port", SERVER_PORT],
      {
        cwd: serverDir,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    server.stdout.on("data", data => {
      serverOutput.push(data.toString());
    })

    server.stderr.on("data", data => {
      serverOutput.push(data.toString());
    })

    const serverUrl = `http://127.0.0.1:${SERVER_PORT}`
    this.dataDir = dataDir
    this.serverUrl = serverUrl
    this.appAdmin = await BaseSeptApp.create("admin", dataDir, serverUrl)
    for (let i = 1; i <= NUM_DEVICES; i++) {
      this[`appDevice${i}`] = await BaseSeptApp.create(`device${i}`, dataDir, serverUrl)
    }

    let cnt = 60 * 2
    while (cnt-- > 0) {
      for (const o of serverOutput) {
        if (o.startsWith(`[wrangler:info] Ready on`)) {
          return
        }
      }
      await sleep(500)
    }
    throw new Error("Timeout starting wrangler")
  }

  async _sync_client_devices(exclude = []) {
    for (let i = 1; i <= NUM_DEVICES; i++) {
      await this[`appDevice${i}`].sync()
    }
  }

  async test_bootstrap_and_add_devices(testId) {
    await this.appAdmin.createNetwork()
    console.log(`Bootstrap done`)

    for (let i = 1; i <= NUM_DEVICES - 1; i++) {
      const deviceData = await this[`appDevice${i}`].initDevice()
      console.log(`Init device${i} done`)
      const { pin, pairing } = await this.appAdmin.addDevice(deviceData)
      console.log(`Device${i} added`)
      await this[`appDevice${i}`].pairDevice(pin)
      await this[`appDevice${i}`].sync()
      await pairing
      console.log(`Device ${i} paired`)
    }

    const i = NUM_DEVICES
    const deviceData = await this[`appDevice${i}`].initDevice()
    console.log(`Init device${i} done`)
    const { pin, pairing: pairingErr } = await this.appAdmin.addDevice(deviceData)
    console.log(`Device${i} added`)
    let failed = false
    const wrongPin = String(
      (Number(pin) + 1) % (10 ** pin.length)
    ).padStart(pin.length, "0")
    try {
      await this[`appDevice${i}`].pairDevice(wrongPin)
    } catch {
      failed = true
    }
    assert(failed, "getPairing should fail with the wrong pin ..")
    failed = false
    try {
      await this[`appDevice${i}`].pairDevice(pin)
    } catch {
      failed = true
    }
    assert(failed, "getPairing should fail with an invalidated pairing session ..")
    failed = false
    try {
      await pairingErr
    } catch {
      failed = true
    }
    assert(failed, "pairingPromise should throw an error")
    const deviceData2 = await this[`appDevice${i}`].initDevice()
    console.log(`Init device${i} second time done`)
    const { pin: pin2, pairing } = await this.appAdmin.addDevice(deviceData2, {} /*, dPaired*/)
    console.log(`Device${i} added second time`)
    await this[`appDevice${i}`].pairDevice(pin2)
    await this[`appDevice${i}`].sync()
    assert(
      deviceData2.deviceId !== deviceData.deviceId,
      "A new pairing attempt must use a new deviceId"
    )
    await pairing
    console.log(`Device ${i} paired`)


    const aDevices = await this.appAdmin.septClient.getDevices();
    assert(aDevices.length == NUM_DEVICES + 1, `aDevices len = ${aDevices.length}`)

    this.appAdminDeviceId = await this.appAdmin.getDeviceId()
    for (let i = 1; i <= NUM_DEVICES; i++) {
      this[`appDevice${i}DeviceId`] = await this[`appDevice${i}`].getDeviceId()
    }

    await this.appAdmin.grant(
      this.appDevice1DeviceId,
      this.appDevice2DeviceId,
      ["message"]
    );
    console.log(`Policy updated`)


    await this._sync_client_devices()
    console.log(`All Devices sync done`)


    const d1Graph = await this.appDevice1.getACL();
    assert(d1Graph.length == 1, `d1Graph len = ${d1Graph.length}`)
    assert(d1Graph[0].srcDeviceId == this.appDevice1DeviceId, `d1Graph[0].srcDeviceId = ${d1Graph[0].srcDeviceId}`)
    assert(d1Graph[0].dstDeviceId == this.appDevice2DeviceId, `d1Graph[0].dstDeviceId = ${d1Graph[0].dstDeviceId}`)
    assert(d1Graph[0].policy.allowedEventTypes[0] == "message", `d1Graph[0].policy = ${JSON.stringify(d1Graph[0].policy)}`)

    const d2Graph = await this.appDevice2.getACL();
    assert(d2Graph.length == 1, `d2Graph len = ${d2Graph.length}`)
    assert(d2Graph[0].srcDeviceId == this.appDevice1DeviceId, `d2Graph[0].srcDeviceId = ${d2Graph[0].srcDeviceId}`)
    assert(d2Graph[0].dstDeviceId == this.appDevice2DeviceId, `d2Graph[0].dstDeviceId = ${d2Graph[0].dstDeviceId}`)
    assert(d2Graph[0].policy.allowedEventTypes[0] == "message", `d2Graph[0].policy = ${JSON.stringify(d2Graph[0].policy)}`)

    await this.appDevice2.disconnect()

  }

  async test_websocket(testId) {
    let connectionOpen = false
    this.appDevice1.septClient.on("connection.open", event => {
      connectionOpen = true
    })
    this.appDevice1.septClient.on("connection.close", event => {
      connectionOpen = false
    })
    await this.appDevice1.connect()
    await sleep(500)
    assert(connectionOpen, "WS connection failed")
    await this.appDevice1.disconnect()
    await sleep(500)
    assert(!connectionOpen, "WS connection close failed")
  }

  // connection.status reports every status change, `connected` included, and
  // listeners already see the new value from getConnectionStatus().
  async test_connection_status(testId) {
    const client1 = this.appDevice1.septClient
    const statuses = []
    let statusOnOpen = null
    const onStatus = ({ status }) => {
      assert(client1.getConnectionStatus() === status, `getConnectionStatus() is ${client1.getConnectionStatus()} in connection.status(${status})`)
      statuses.push(status)
    }
    const onOpen = () => { statusOnOpen = client1.getConnectionStatus() }
    client1.on("connection.status", onStatus)
    client1.on("connection.open", onOpen)
    try {
      await this.appDevice1.connect()
      assert(client1.getConnectionStatus() === "connected", `Status after connect(): ${client1.getConnectionStatus()}`)
      assert(statusOnOpen === "connecting", `Status on connection.open: ${statusOnOpen}`)
      await this.appDevice1.disconnect()
      for (let t = 0; t < 20 && statuses.at(-1) !== "disconnected"; t++) {
        await sleep(100)
      }
    } finally {
      client1.off("connection.status", onStatus)
      client1.off("connection.open", onOpen)
    }
    const expected = ["connecting", "connected", "disconnecting", "disconnected"]
    assert(
      JSON.stringify(statuses) === JSON.stringify(expected),
      `connection.status sequence: ${JSON.stringify(statuses)}`
    )
  }

  // createNetwork() is all-or-nothing: a failure leaves no network, device ID
  // or keys behind, and the call can be retried.
  async test_create_network_atomic(testId) {
    const app = await BaseSeptApp.create("create-network", this.dataDir, "http://127.0.0.1:1")
    const client = app.septClient
    const assertNoIdentity = async (when) => {
      const settings = await client.store.settings.get()
      assert(await client.getNetworkId() === null, `${when}: network left behind`)
      assert(await client.getDeviceId() === null, `${when}: deviceId left behind`)
      assert(!settings.deviceSignPrivateKey && !settings.deviceCryptPrivateKey, `${when}: keys left behind`)
      assert((await client.getDevices()).length === 0, `${when}: device left behind`)
    }

    // Relay unreachable
    let failed = false
    try {
      await client.createNetwork()
    } catch {
      failed = true
    }
    assert(failed, "createNetwork() should fail with an unreachable relay")
    await assertNoIdentity("Relay unreachable")

    // Local write fails after the relay accepted the network
    client.restEndpoint = this.serverUrl
    const deviceAdd = client.store.device.add
    client.store.device.add = async () => { throw new Error("disk full") }
    failed = false
    try {
      await client.createNetwork()
    } catch (e) {
      failed = String(e).includes("disk full")
    } finally {
      client.store.device.add = deviceAdd
    }
    assert(failed, "createNetwork() should fail when a local write fails")
    await assertNoIdentity("Local write failed")

    // Retry succeeds
    const networkId = await client.createNetwork()
    assert(networkId && await client.getNetworkId() === networkId, "Retried createNetwork() did not save the network")
    const deviceId = await client.getDeviceId()
    assert(deviceId, "Retried createNetwork() did not save the deviceId")
    assert(await client.isCurrentDeviceAdmin(), "Root device should be admin")
    const ticket = await client.callRest("get-relay-ticket")
    assert(ticket.json?.ticket, "Relay does not know the new root device")

    // A device with an identity cannot create another network
    failed = false
    try {
      await client.createNetwork()
    } catch (e) {
      failed = String(e).includes("cannot bootstrap")
    }
    assert(failed, "createNetwork() should refuse a device that already has an identity")
    assert(await client.getNetworkId() === networkId && await client.getDeviceId() === deviceId, "Refused createNetwork() changed the identity")

    // Relay refuses (network limit reached)
    await client.resetDevice()
    failed = false
    try {
      await client.createNetwork()
    } catch (e) {
      failed = String(e).includes("403")
    }
    assert(failed, "createNetwork() should fail when the relay refuses it")
    await assertNoIdentity("Relay refused")
  }

  async test_send_messages(testId) {
    const eventId = await this.appAdmin.send("message", "test1", [this.appDevice1DeviceId])
    console.log(`Message sent admin -> device1`)
    assert(typeof eventId === "string" && eventId.startsWith("evt"), `send() did not return the event ID: ${eventId}`)
    const [outgoing] = await this.appAdmin.getStoredEvents({ id: eventId })
    assert(outgoing?.isOutgoing && outgoing.payload === "test1", "send() returned an ID that does not match the stored outgoing event")
    await this.appDevice1.sync()
    console.log(`Device 1 sync done`)
    const [incoming] = await this.appDevice1.getStoredEvents({ id: eventId })
    assert(incoming?.isIncoming && incoming.payload === "test1", "Recipient did not store the event under the ID send() returned")

    await this.appDevice1.send("message", "test2", [this.appDevice2DeviceId])
    console.log(`Message sent device1 -> device2`)
    await this.appDevice2.sync()
    console.log(`Device 2 sync done`)
  }

  async test_policy_device2_to_device1(testId) {

    await this.appAdmin._updatePolicy(
      this.appDevice2DeviceId,
      this.appDevice1DeviceId,
      []
    );
    console.log(`Policy updated`)

    await this.appDevice1.sync()
    console.log(`Device 1 sync done`)
    await this.appDevice2.sync()
    console.log(`Device 2 sync done`)

    const d1Graph = await this.appDevice1.getACL();
    assert(d1Graph.length == 2, `d1Graph len = ${d1Graph.length}`)
    assert(d1Graph[1].srcDeviceId == this.appDevice2DeviceId, `d1Graph[1].srcDeviceId = ${d1Graph[1].srcDeviceId}`)
    assert(d1Graph[1].dstDeviceId == this.appDevice1DeviceId, `d1Graph[1].dstDeviceId = ${d1Graph[1].dstDeviceId}`)

    const d2Graph = await this.appDevice2.getACL();
    assert(d2Graph.length == 2, `d2Graph len = ${d2Graph.length}`)
    assert(d2Graph[1].srcDeviceId == this.appDevice2DeviceId, `d2Graph[1].srcDeviceId = ${d2Graph[1].srcDeviceId}`)
    assert(d2Graph[1].dstDeviceId == this.appDevice1DeviceId, `d2Graph[1].dstDeviceId = ${d2Graph[1].dstDeviceId}`)

  }


  async test_policy_deny(testId) {

    await this.appAdmin.revoke(
      this.appDevice2DeviceId,
      this.appDevice1DeviceId,
      ["message"]
    );
    console.log(`Policy updated`)

    await this.appDevice1.sync()
    console.log(`Device 1 sync done`)
    await this.appDevice2.sync()
    console.log(`Device 2 sync done`)
    let empty_rcpt_list = false
    try {
      console.log("> Ignore message below:")
      await this.appDevice2.send("message", testId, [this.appDevice1DeviceId])
    } catch {
      empty_rcpt_list = true
    }

    assert(empty_rcpt_list, "empty_rcpt_list")

    await this.appDevice1.sync()
    await this.appDevice2.sync()

    for (const act of await this.appDevice1.getStoredEvents()) {
      assert(act.payload !== testId, `${act.payload}`)
    }

    for (const act of await this.appDevice2.getStoredEvents()) {
      assert(act.payload !== testId, `${act.payload}`)
    }

    // Bypass local policy check
    await this.appDevice2.septClient.store.deviceGraphEdge.setPolicy(
      this.appDevice2DeviceId,
      this.appDevice1DeviceId,
      { allowedEventTypes: ["message"] }
    );

    await this.appDevice2.send("message", testId, [this.appDevice1DeviceId])

    console.log("> Ignore message below:")
    await this.appDevice1.sync()
    await this.appDevice2.sync()

    for (const act of await this.appDevice1.getStoredEvents()) {
      assert(act.payload !== testId, `After bypass ${act.payload}`)
    }
    let found = false;
    for (const act of await this.appDevice2.getStoredEvents()) {
      if (act.payload === testId) {
        found = true;
        break
      }
    }
    assert(found, "After bypass sender device did not create local event")
  }


  async test_non_admin_policy_update(testId) {
    try {
      await this.appDevice1.grant(
        this.appDevice2DeviceId,
        this.appDevice1DeviceId,
        ["message"]
      );
    } catch {
      return
    }
    assert(false, "Non admin updated policy")
  }

  async test_admin_policy(testId) {
    await this.appAdmin.grant(
      this.appDevice1DeviceId,
      this.appAdminDeviceId,
      ["message"]
    );
    console.log(`Policy updated`)

    await this.appDevice1.sync()

    const policy1Admin = await this.appDevice1.getPolicy(this.appDevice1DeviceId, this.appAdminDeviceId)
    assert(
      policy1Admin.allowedEventTypes.includes("message"),
      `Device1: Device1 policy error to Admin: ${JSON.stringify(policy1Admin)}`
    )

    const policyAdmin1 = await this.appAdmin.getPolicy(this.appDevice1DeviceId, this.appAdminDeviceId)
    assert(
      policyAdmin1.allowedEventTypes.includes("message"),
      `Admin: Device1 policy error to Admin: ${JSON.stringify(policy1Admin)}`
    )

    console.log(`Policy check OK `)
  }

  async test_send_message_to_myself(testId) {
    await this.appAdmin.grant(
      this.appDevice1DeviceId,
      this.appDevice1DeviceId,
      ["message"]
    );
    await this.appDevice1.sync()
    await this.appDevice1.send("message", testId, [this.appDevice1DeviceId])
    console.log(`Message sent device1 -> device1`)
    await this.appDevice1.sync()
    console.log(`Device 1 sync done`)
    const storedMessages = await this.appDevice1.getStoredEvents()
    const mess = storedMessages.find(m => m.payload === testId)
    assert(mess, `Message not found: ${JSON.stringify(storedMessages)}`)
    assert(mess?.isIncoming && mess?.isOutgoing, `Message should be both Incoming and Outgoing: ${mess?.isIncoming} ${mess?.isOutgoing}`)
  }

  async test_filter_events(testId) {
    let r
    r = await this.appAdmin.getStoredEvents({
      type: "message",
      isOutgoing: true,
      device: { role__ne: "admin" },
    })
    assert(r.length > 0, "Failed to filter messages 1")

    r = await this.appAdmin.getStoredEvents({
      type: "message",
      type__isnot: null,
      isOutgoing: true,
      device: { role__in: ["user"] },
      recipient: { deviceId__ne: "xxx" },
      sequence__gt: 1
    })
    assert(r.length > 0, "Failed to filter messages 2")
    assert(r[0].sequence > 1, "Failed to filter messages 3")

    r = await this.appAdmin.getStoredEvents({
      type: "message",
      isOutgoing: true,
      device: { role__ne: "admin" },
      recipient: { deviceId__notin: ["xxx", "yyy"] },
      sequence__gt: 1
    })
    assert(r.length > 0, "Failed to filter messages 2")

    let failed

    failed = false
    try {
      await this.appAdmin.getStoredEvents({
        typeX: "message",
      })
    } catch {
      failed = true
    }
    assert(failed, "Event filter didn't throw error on wrong field name")

    failed = false
    try {
      await this.appAdmin.getStoredEvents({
        type__X: "message",
      })
    } catch {
      failed = true
    }
    assert(failed, "Event filter didn't throw error on wrong operator")
  }

  async test_admin_grant(testId) {

    await this.appAdmin.grant(
      this.appDevice2DeviceId,
      this.appDevice3DeviceId,
      ["message"]
    );
    await this._sync_client_devices()

    let d1Graph = await this.appDevice1.septClient.getACL()
    let aGraph = await this.appAdmin.septClient.getACL()
    assert(
      canonicalJson(d1Graph) !== canonicalJson(aGraph),
      "Device graph is the same between admin and Device1, this test may be incompete"
    )

    await this.appAdmin.grantAdmin(this.appDevice1DeviceId)
    await this._sync_client_devices()

    d1Graph = (await this.appDevice1.septClient.getACL()).map(p => ({
      srcDeviceId: p.srcDeviceId,
      dstDeviceId: p.dstDeviceId,
      policy: p.policy
    }))
    aGraph = (await this.appAdmin.septClient.getACL()).map(p => ({
      srcDeviceId: p.srcDeviceId,
      dstDeviceId: p.dstDeviceId,
      policy: p.policy
    }))

    assert(
      canonicalJson(d1Graph) === canonicalJson(aGraph),
      `Device graph differes between admins: ${JSON.stringify(d1Graph, null, 2)} !== ${JSON.stringify(aGraph, null, 2)}`
    )
    const d1Devices = await this.appDevice1.septClient.store.device.getAll()
    for (let i = 2; i <= NUM_DEVICES; i++) {
      assert(
        d1Devices.map(d => d.id).includes(this[`appDevice${i}DeviceId`]),
        `Missing Device${i} from Device1 list (Device1 is now admin)`
      )
    }

    const d4Devices = await this.appDevice4.septClient.getDevices()
    assert(
      d4Devices.map(d => d.id).includes(this.appDevice1DeviceId),
      "Missing Device1 from Device4"
    )

    let d1Data = await this.appDevice1._getDeviceData()
    assert(d1Data.isAdmin, "Device1 should be admin")

    let d1DataOfD2 = await this.appDevice2.septClient.store.device.get(this.appDevice1DeviceId)
    assert(d1DataOfD2.role === "admin", "Device1 should be admin on Device2")

    const d1DataOfAdmin = await this.appAdmin.septClient.store.device.get(this.appDevice1DeviceId)
    assert(d1DataOfAdmin.role === "admin", "Device1 should be admin on Admin")


    let adminMessages
    await this.appDevice2.sync()
    try {
      console.log("> Ignore message below:")
      await this.appDevice2.send("message", `${testId}-1`, [this.appAdminDeviceId])
    } catch { }
    await this.appAdmin.sync()
    adminMessages = await this.appAdmin.getStoredEvents({
      type: "message",
      payload: `${testId}-1`
    })
    assert(adminMessages.length === 0, "Admin got the message from Device2")

    await this.appDevice1.grant(
      this.appDevice2DeviceId,
      this.appAdminDeviceId,
      ["message"]
    )
    await this.appDevice2.sync()
    await this.appAdmin.sync()
    await this.appDevice2.send("message", `${testId}-1`, [this.appAdminDeviceId])
    await this.appAdmin.sync()
    adminMessages = await this.appAdmin.getStoredEvents({
      type: "message",
      payload: `${testId}-1`
    })
    assert(adminMessages.length > 0, "Admin did not get the message from Device2")

    await this.appAdmin.revokeAdmin(this.appDevice1DeviceId)

    await this._sync_client_devices()
    d1Data = await this.appDevice1._getDeviceData()
    assert(!d1Data.isAdmin, "Device1 should be NOT admin")
    let failed = false
    try {
      await this.appDevice1.grant(
        this.appDevice2DeviceId,
        this.appAdminDeviceId,
        ["message"]
      )
    } catch {
      failed = true
    }

    assert(failed, "Device1 should not be able to invoke admin actions")

    d1DataOfD2 = await this.appDevice2.septClient.store.device.get(this.appDevice1DeviceId)
    assert(d1DataOfD2.role !== "admin", "Device1 should NOT be admin on Device2")
  }

  async test_app_storage(testId) {
    const st = this.appAdmin.septClient.appStorage("test")
    await st.set("test1", "value 1")
    await st.set("test2", "value 2")
    let keys = await st.keys()
    assert(keys.includes("test1"), `Missing appStore key 'test1, keys are ${JSON.stringify(keys)}`)
    assert(keys.includes("test2"), `Missing appStore key 'test2, keys are ${JSON.stringify(keys)}`)
    assert(await st.get("test1") === "value 1", `Wrong appStore value`)

    await st.delete("test2")
    keys = await st.keys()
    assert(!keys.includes("test2"), `Missing appStore key delete 'test2`)

    await st.set("test1", "value 3")
    assert(await st.get("test1") === "value 3", `Wrong appStore value update`)
  }


  async test_invalidate_device(testId) {
    const devices = await this.appDevice1.septClient.getDevices()
    await this.appAdmin.septClient.invalidateDevice(this.appDevice2DeviceId)
    await this.appDevice1.sync()
    const devices1 = await this.appDevice1.septClient.getDevices()

    assert(devices1.length === devices.length - 1, "Device not invalidated")
    // The relay refuses the invalidated device. send() does not reject on
    // relay failures: the event stays undelivered and never reaches Device1.
    const eventId = await this.appDevice2.send("message", testId, [this.appDevice1DeviceId])
    const [sent] = await this.appDevice2.getStoredEvents({ id: eventId })
    assert(sent && sent.sequence === null, "Relay accepted an event from an invalidated device")
    await this.appDevice1.sync()
    assert(
      !(await this.appDevice1.getStoredEvents({ type: "message" })).some(e => e.payload === testId),
      "Device1 received an event from an invalidated device"
    )

    const graph = await this.appDevice1.septClient.getACL()
    for (const g of graph) {
      assert(
        g.srcDeviceId !== this.appDevice2DeviceId && g.dstDeviceId !== this.appDevice2DeviceId,
        "Revoked device still in device_graph"
      )
    }
  }

  // sync() and WebSocket delivery must not interleave: every event is
  // processed exactly once, in send order.
  async test_event_ordering(testId) {
    const client1 = this.appDevice1.septClient
    const N = 20
    const received = []
    client1.register(testId, async ({ payload }) => {
      await sleep(5) // widen the window for interleaving
      received.push(payload)
    })

    await this.appDevice1.connect()

    let done = false
    const syncLoop = (async () => {
      while (!done) {
        await client1.sync()
        await sleep(10)
      }
    })()

    for (let i = 0; i < N; i++) {
      await this.appAdmin.send(testId, i, [this.appDevice1DeviceId])
    }

    for (let t = 0; t < 100 && received.length < N; t++) {
      await sleep(100)
    }
    done = true
    await syncLoop
    await this.appDevice1.disconnect()

    assert(received.length === N, `Expected ${N} events, got ${received.length}: ${JSON.stringify(received)}`)
    for (let i = 0; i < N; i++) {
      assert(received[i] === i, `Events out of order: ${JSON.stringify(received)}`)
    }
  }

  // A throwing application handler is recorded and reported, but must not
  // abort the batch: sync() resolves and the next event is still handled.
  async test_handler_failure(testId) {
    const client1 = this.appDevice1.septClient
    const received = []
    const failures = []
    client1.register(testId, async ({ payload }) => {
      if (payload === "bad") {
        throw new Error("malformed payload")
      }
      received.push(payload)
    })
    client1.on("handler.failure", f => { failures.push(f) })

    // Device1 is disconnected: both events arrive in the same sync() batch.
    await this.appAdmin.send(testId, "bad", [this.appDevice1DeviceId])
    await this.appAdmin.send(testId, "good", [this.appDevice1DeviceId])

    await client1.sync()

    assert(received.length === 1 && received[0] === "good", `Event after the failing one not handled: ${JSON.stringify(received)}`)

    const [bad] = await client1.getStoredEvents({ type: testId, payload: "bad" })
    assert(bad, "Failing event not stored")
    assert(bad.handlerFailed, "Failing event not marked as handlerFailed")
    assert(bad.processedAt !== null, "Failing event not marked as processed")
    assert(String(bad.handlerResult).includes("malformed payload"), `Wrong handlerResult: ${bad.handlerResult}`)

    const [good] = await client1.getStoredEvents({ type: testId, payload: "good" })
    assert(good && !good.handlerFailed && good.processedAt !== null, "Event after the failing one not processed")

    assert(failures.length === 1, `handler.failure dispatched ${failures.length} times`)
    assert(failures[0].eventId === bad.id && failures[0].type === testId, `Wrong handler.failure payload: ${JSON.stringify(failures[0])}`)
    assert(failures[0].error === "malformed payload", `Wrong handler.failure error: ${failures[0].error}`)

    // Both events were ACKed: nothing left pending on the relay
    const pending = await client1.callRest("events")
    assert(pending.json.events.length === 0, `Events still pending after sync: ${pending.json.events.length}`)
  }

  // Patches the admin's REST calls to POST /event; restore() undoes it.
  _patchAdminPostEvent(patch) {
    const admin = this.appAdmin.septClient
    const callRest = admin._callRest
    admin._callRest = async (path, options) => {
      if (path === "event" && options?.method === "POST") {
        return await patch(() => callRest.call(admin, path, options), options)
      }
      return await callRest.call(admin, path, options)
    }
    return () => { admin._callRest = callRest }
  }

  // An event the relay did not get is kept and resent with the same ID on the
  // next sync(); the recipient gets it exactly once.
  async test_resend_undelivered(testId) {
    const admin = this.appAdmin.septClient
    const received = []
    this.appDevice1.septClient.register(testId, ({ payload, eventId }) => { received.push({ payload, eventId }) })
    const deliveries = []
    const onDelivery = d => { deliveries.push(d) }
    admin.on("event.delivery", onDelivery)

    try {
      // 1. Relay unreachable on the first POST: send() resolves, the event is queued
      const restore = this._patchAdminPostEvent(async () => { throw new TypeError("fetch failed") })
      let eventId
      try {
        eventId = await this.appAdmin.send(testId, "queued", [this.appDevice1DeviceId])
      } finally {
        restore()
      }
      let [stored] = await admin.getStoredEvents({ id: eventId })
      assert(stored && stored.sequence === null && !stored.deliveryFailed, `Undelivered event not queued: ${JSON.stringify(stored)}`)
      const undelivered = await admin.getStoredEvents({ isOutgoing: true, sequence__is: null, deliveryFailed: false })
      assert(undelivered.some(e => e.id === eventId), "Queued event not listed as undelivered")
      assert(deliveries.length === 0, `Unexpected event.delivery: ${JSON.stringify(deliveries)}`)

      await this.appDevice1.sync()
      assert(received.length === 0, "Recipient got an event the relay never accepted")

      // sync() resends it under the same ID
      await this.appAdmin.sync()
      ;[stored] = await admin.getStoredEvents({ id: eventId })
      assert(stored.sequence !== null, "Event not resent by sync()")
      assert(stored.encryptedPayload === null, "Ciphertext kept after delivery")
      assert(deliveries.length === 1 && deliveries[0].eventId === eventId && deliveries[0].status === "delivered" && deliveries[0].sequence === stored.sequence, `Wrong event.delivery: ${JSON.stringify(deliveries)}`)

      await this.appDevice1.sync()
      await this.appDevice1.sync()
      assert(received.length === 1 && received[0].eventId === eventId && received[0].payload === "queued", `Resent event not received exactly once: ${JSON.stringify(received)}`)

      // 2. The relay stored the event but the response was lost: the resend
      // gets the same sequence back and nothing is delivered twice.
      let relaySequence = null
      const restore2 = this._patchAdminPostEvent(async (post) => {
        relaySequence = (await post()).json.sequence
        throw new TypeError("connection reset")
      })
      let eventId2
      try {
        eventId2 = await this.appAdmin.send(testId, "response-lost", [this.appDevice1DeviceId])
      } finally {
        restore2()
      }
      ;[stored] = await admin.getStoredEvents({ id: eventId2 })
      assert(relaySequence !== null && stored.sequence === null, "Lost response not simulated")
      await this.appAdmin.sync()
      ;[stored] = await admin.getStoredEvents({ id: eventId2 })
      assert(stored.sequence === relaySequence, `Resend got sequence ${stored.sequence}, relay had ${relaySequence}`)

      await this.appDevice1.sync()
      await this.appDevice1.sync()
      const got2 = received.filter(r => r.eventId === eventId2)
      assert(got2.length === 1, `Event with a lost response received ${got2.length} times`)
      const stillPending = await this.appDevice1.septClient.callRest("events")
      assert(!stillPending.json.events.some(e => e.eventId === eventId2), "Duplicate left pending on the relay")

      // 3. A permanent refusal stops the retries and is reported
      const restore3 = this._patchAdminPostEvent(async () => {
        const err = new Error("REST: 404")
        err.status = 404
        err.code = "unauthorized"
        throw err
      })
      let eventId3
      try {
        eventId3 = await this.appAdmin.send(testId, "refused", [this.appDevice1DeviceId])
      } finally {
        restore3()
      }
      ;[stored] = await admin.getStoredEvents({ id: eventId3 })
      assert(stored.deliveryFailed && stored.sequence === null && stored.deliveryError === "REST 404: unauthorized", `Refused event not marked failed: ${JSON.stringify(stored)}`)
      const failed = deliveries.filter(d => d.eventId === eventId3)
      assert(failed.length === 1 && failed[0].status === "failed" && failed[0].error === "REST 404: unauthorized", `Wrong event.delivery for refusal: ${JSON.stringify(failed)}`)
      await this.appAdmin.sync()
      ;[stored] = await admin.getStoredEvents({ id: eventId3 })
      assert(stored.sequence === null, "Permanently refused event was resent")
      await this.appDevice1.sync()
      assert(!received.some(r => r.eventId === eventId3), "Recipient got a refused event")

      // 4. An event the relay keeps failing on (500) stays queued but does not
      // block the events sent after it
      let poisonedId = null
      const restore4 = this._patchAdminPostEvent(async (post, options) => {
        if (poisonedId === null || options.body.eventId === poisonedId) {
          const err = new Error("REST: 500")
          err.status = 500
          err.code = "internal_error"
          throw err
        }
        return await post()
      })
      let eventId5
      try {
        poisonedId = await this.appAdmin.send(testId, "poisoned", [this.appDevice1DeviceId])
        eventId5 = await this.appAdmin.send(testId, "after-poisoned", [this.appDevice1DeviceId])
        await this.appAdmin.sync()
      } finally {
        restore4()
      }
      const [poisoned] = await admin.getStoredEvents({ id: poisonedId })
      const [after] = await admin.getStoredEvents({ id: eventId5 })
      assert(poisoned.sequence === null && !poisoned.deliveryFailed, `Event failing with 500 not kept queued: ${JSON.stringify(poisoned)}`)
      assert(after.sequence !== null, "An event failing with 500 blocked the next one")
      await this.appAdmin.sync()
      const [recovered] = await admin.getStoredEvents({ id: poisonedId })
      assert(recovered.sequence !== null, "Event failing with 500 not resent once the relay recovered")
      await this.appDevice1.sync()
      for (const id of [poisonedId, eventId5]) {
        const n = received.filter(r => r.eventId === id).length
        assert(n === 1, `${id} received ${n} times`)
      }
    } finally {
      admin.off("event.delivery", onDelivery)
    }
  }

  // Opening a version-1 database adds the resend columns; undelivered events
  // from before (no stored ciphertext) are marked as not resendable.
  async test_db_migration_v2(testId) {
    const app = await BaseSeptApp.create("migration", this.dataDir, this.serverUrl)
    const db = app.septClient.dbAdapter
    // Turn the fresh database back into a version-1 one
    for (const col of ["encrypted_payload", "delivery_failed", "delivery_error"]) {
      await db.write(`ALTER TABLE event DROP COLUMN ${col}`, [])
    }
    await db.write(`PRAGMA user_version = 1`, [])
    const insert = `INSERT INTO event (id, type, sender_device_id, payload_key, payload, timestamp, sequence, is_system, is_outgoing, is_incoming)
      VALUES (?, 'message', 'dev_x', 'key', '"x"', 1, ?, 0, ?, ?)`
    await db.write(insert, ["evt_undelivered", null, 1, 0])
    await db.write(insert, ["evt_delivered", 7, 1, 0])
    await db.write(insert, ["evt_incoming", 8, 0, 1])

    const reopened = await BaseSeptApp.create("migration", this.dataDir, this.serverUrl, { clearDb: false })
    const client = reopened.septClient
    const version = (await client.dbAdapter.readOne("PRAGMA user_version")).userVersion
    assert(version === 2, `DB version after migration: ${version}`)
    const byId = async id => (await client.getStoredEvents({ id }))[0]
    const undelivered = await byId("evt_undelivered")
    assert(undelivered.deliveryFailed && String(undelivered.deliveryError).startsWith("cannot resend"), `Old undelivered event not marked: ${JSON.stringify(undelivered)}`)
    for (const id of ["evt_delivered", "evt_incoming"]) {
      const e = await byId(id)
      assert(!e.deliveryFailed && e.deliveryError === null, `${id} wrongly marked: ${JSON.stringify(e)}`)
    }
    assert((await client.store.event.getUndelivered()).length === 0, "Old undelivered event would be resent")
  }

  // Must run last: it leaves Device3 permanently in system failure.
  async test_system_failure(testId) {
    const client3 = this.appDevice3.septClient
    const failures = []
    client3.on("system.failure", f => { failures.push(f) })

    assert(await client3.getSystemFailure() === null, "Device3 should not start in system failure")

    // A sept.device.add for an existing device with different keys cannot be
    // applied: Device3 must enter system failure.
    const badKey = serializeBin(new Uint8Array(32).fill(9))
    await this.appAdmin.send("sept.device.add", {
      id: this.appDevice1DeviceId,
      networkId: await this.appAdmin.septClient.getNetworkId(),
      signPublicKey: badKey,
      cryptPublicKey: badKey,
    }, [this.appDevice3DeviceId])
    // Sent after the failing event: must not be processed
    await this.appAdmin.send("message", testId, [this.appDevice3DeviceId])

    const d1Before = await client3.store.device.get(this.appDevice1DeviceId)

    await this.appDevice3.sync()

    const failure = await client3.getSystemFailure()
    assert(failure?.type === "sept.device.add", `System failure not recorded: ${JSON.stringify(failure)}`)
    assert(failures.length === 1 && failures[0].eventId === failure.eventId, "system.failure event not dispatched")

    const d1After = await client3.store.device.get(this.appDevice1DeviceId)
    assert(
      serializeBin(d1After.signPublicKey) === serializeBin(d1Before.signPublicKey),
      "Conflicting device keys were applied"
    )

    const stored = await this.appDevice3.getStoredEvents({ type: "message" })
    assert(!stored.some(e => e.payload === testId), "Event after the failing one was stored")

    // Not ACKed: the later event is still pending on the relay
    const pending = await client3.callRest("events")
    assert(pending.json.events.length > 0, "Event after the failing one was ACKed")

    // Nothing else is processed, sent or connected
    await this.appDevice3.sync()
    assert(
      !(await this.appDevice3.getStoredEvents({ type: "message" })).some(e => e.payload === testId),
      "Event processed after system failure"
    )

    let failed = false
    try {
      await this.appDevice3.send("message", testId, [this.appAdminDeviceId])
    } catch {
      failed = true
    }
    assert(failed, "send() should throw after system failure")

    await this.appDevice3.connect()
    assert(client3.getConnectionStatus() === "disconnected", "connect() should not connect after system failure")
    assert(failures.length === 2, "connect() should dispatch system.failure")
  }
}


async function main() {
  const septTest = new SeptTest()
  await septTest.init()
  const tests = Object.getOwnPropertyNames(SeptTest.prototype)
    .filter(t => t.startsWith("test_"))

  const errors = []
  for (const t of tests) {
    console.log(`Running ${t}`)
    try {
      await septTest[t](t)
      console.log(`${t} ... OK`)
    } catch (e) {
      errors.push(`${t}: ${e}`)
      console.log(`${t} ... ERROR`)
    }
    console.log("---------------")
  }
  server.kill()
  if (errors.length > 0) {
    for (const e of errors) {
      console.log(e)
    }
    process.exit(1)
  }
  console.log("ALL TESTS PASSED")
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
