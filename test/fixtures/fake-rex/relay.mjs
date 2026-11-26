import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, cwd, ...argv] = process.argv.slice(2);
const input = join(dir, "input");
const output = join(dir, "output");

const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
writeFileSync(join(dir, "child.pid"), String(child.pid ?? ""));
child.stdout.on("data", (d) => appendFileSync(output, d));
child.stderr.on("data", (d) => appendFileSync(output, d));
child.stdin.on("error", () => {});

let offset = 0;
const pump = setInterval(() => {
  let fd;
  try {
    fd = openSync(input, "r");
    const buf = Buffer.alloc(65536);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      offset += n;
      child.stdin.write(Buffer.from(buf.subarray(0, n)));
    }
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}, 20);

const finish = (exit) => {
  clearInterval(pump);
  writeFileSync(join(dir, "exit.json"), JSON.stringify(exit));
  process.exit(0);
};
child.on("error", (err) => finish({ exit_code: 127, error: err.message }));
child.on("close", (code, signal) => finish(signal ? { exit_code: 128, error: `signal ${signal}` } : { exit_code: code ?? 0 }));
for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
