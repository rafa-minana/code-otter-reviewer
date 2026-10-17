console.log("worker started (no task runner yet)");
// Keep the process alive until Graphile Worker is wired in.
setInterval(() => {}, 1 << 30);
