const isTTY = process.stdout.isTTY;

function cyan(s: string): string {
  return isTTY ? `\x1b[36m${s}\x1b[0m` : s;
}
function dim(s: string): string {
  return isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

export function startSpinner(message: string): () => void {
  if (!isTTY) {
    process.stdout.write(message + "\n");
    return () => {};
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const start = Date.now();
  const interval = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(
      `\r  ${cyan(frames[i % frames.length])}  ${message} ${dim(`(${elapsed}s)`)}`,
    );
    i++;
  }, 100);
  return () => {
    clearInterval(interval);
    process.stdout.write("\r" + " ".repeat(70) + "\r");
  };
}
