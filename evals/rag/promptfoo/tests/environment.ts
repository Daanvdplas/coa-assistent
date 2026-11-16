/** Tests preserve system configuration while isolating every live-run control. */
export function isolateEnvironment(): () => void {
  const before = { ...process.env };
  for (const key of Object.keys(process.env))
    if (/^(COA_|OPENAI_|ORQ_)/.test(key) || key === "CODEX_HOME")
      delete process.env[key];
  return () => {
    for (const key of Object.keys(process.env))
      if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  };
}
