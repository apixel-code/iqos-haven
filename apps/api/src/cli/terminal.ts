/**
 * Reads a line from a TTY without echoing it (raw mode). Ctrl-C/Ctrl-D or a closed stdin abort;
 * escape sequences (arrow keys etc.) are ignored rather than added to the password. The
 * terminal is always restored.
 */
export function promptHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    let value = "";
    let escape = false;
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onEnd = () => finish(new Error("Aborted"));
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (escape) {
          // CSI sequences end with a letter or "~"; plain ESC+char pairs end immediately.
          if (/[A-Za-z~]/.test(char)) escape = false;
          continue;
        }
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003" || char === "\u0004") return finish(new Error("Aborted"));
        if (char === "\u001b") escape = true;
        else if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
    input.once("end", onEnd);
  });
}

/** First line of stdin (automation via --password-stdin); the trailing newline is dropped. */
export async function readFirstStdinLine(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
    if (data.includes("\n") || data.length > 4096) break;
  }
  return data.split(/\r?\n/)[0] ?? "";
}
