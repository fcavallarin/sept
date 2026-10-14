export class AsyncQueue {
  constructor(handler) {
    this.handler = handler;
    this.queue = [];
    this.running = false;
  }

  push = (item) => {
    this.queue.push(item);
    this.run();
  }

  run = async () => {
    if (this.running) return;
    this.running = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        try {
          await this.handler(item);
        } catch (e) {
          // push() does not await run(): an escaping error would be an
          // unhandled rejection and terminate Node processes.
          console.error("AsyncQueue handler error:", e);
        }
      }
    } finally {
      this.running = false;
      if (this.queue.length > 0) {
        this.run();
      }
    }
  }
}