export async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Startup dependency timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function handleSystemJob(job: { name: string }): Promise<{ ok: true }> {
  if (job.name !== "healthcheck") throw new Error("Unsupported system job");
  return { ok: true };
}
