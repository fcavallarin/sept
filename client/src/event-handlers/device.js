import { canonicalJson, deserializeBin, serializeBin, now } from "@sept-protocol/core";
import { verifyString } from "@sept-protocol/crypto";
import { BaseEventHandler } from './base.js'

export class DeviceHandler extends BaseEventHandler {

  async handle() {
    switch (this.event) {
      case "add": {
        const existing = await this.store.device.get(this.payload.id)
        if (existing) {
          // Already known (e.g. from an earlier policy update): no-op if the
          // keys match, never silently replace them.
          if (
            serializeBin(existing.signPublicKey) !== this.payload.signPublicKey ||
            serializeBin(existing.cryptPublicKey) !== this.payload.cryptPublicKey
          ) {
            throw new Error(`Device ${this.payload.id} already exists with different keys`)
          }
          break
        }
        await this.store.device.add({
          id: this.payload.id,
          networkId: this.payload.networkId,
          signPublicKey: deserializeBin(this.payload.signPublicKey),
          cryptPublicKey: deserializeBin(this.payload.cryptPublicKey),
        })
        this.uiEvents.dispatch("sept.device.add", this.payload)
        break
      }
      case "invalidate":
        await this.store.device.upsert(this.payload.deviceId, { revokedAt: now() })
        this.uiEvents.dispatch("sept.device.invalidate", this.payload)
        break
    }
  }
}