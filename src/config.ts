import { z } from "zod";

function parseEnvArray(key: string): string[] | undefined {
  const value = process.env[key];
  if (!value) return undefined;
  return value.split(/[,\s]+/).filter((v) => v.trim().length > 0);
}

const ConfigSchema = z.object({
  letterboxd: z.array(z.string()).default([]),
  myanimelist: z.array(z.string()).default([]),
  discordWebhook: z.string().url().nullable().optional(),
  port: z.number().int().positive().default(3000),
  refreshInterval: z.number().int().positive().default(300),
});

export type Config = z.infer<typeof ConfigSchema>;

async function loadConfigFile(): Promise<Partial<z.infer<typeof ConfigSchema>>> {
  try {
    const configFile = Bun.file("config.json");
    if (!(await configFile.exists())) return {};
    const rawConfig = JSON.parse(await configFile.text());
    return ConfigSchema.partial().parse(rawConfig);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Config validation error: ${error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`);
    }
    console.warn("[WARNING] Failed to load config.json, using defaults and environment variables only");
    return {};
  }
}

export async function loadConfig(): Promise<Config> {
  const configFileData = await loadConfigFile();

  // Parse environment variables
  const envData: Partial<z.infer<typeof ConfigSchema>> = {
    letterboxd: parseEnvArray("LETTERBOXD_USERS"),
    myanimelist: parseEnvArray("MYANIMELIST_USERS"),
    discordWebhook: process.env.DISCORD_WEBHOOK || undefined,
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : undefined,
    refreshInterval: process.env.REFRESH_INTERVAL ? parseInt(process.env.REFRESH_INTERVAL, 10) : undefined,
  };

  // Merge: env > config file > defaults
  return ConfigSchema.parse({
    ...configFileData,
    ...Object.fromEntries(Object.entries(envData).filter(([, v]) => v !== undefined)),
  });
}

export function printConfig(config: Config): void {
  console.log("=== Configuration ===");
  console.log(`Letterboxd users: ${config.letterboxd.length > 0 ? config.letterboxd.join(", ") : "(none)"}`);
  console.log(`MyAnimeList users: ${config.myanimelist.length > 0 ? config.myanimelist.join(", ") : "(none)"}`);
  console.log(`Discord webhook: ${config.discordWebhook ? "configured" : "not configured"}`);
  console.log(`Port: ${config.port}`);
  console.log(`Refresh interval: ${config.refreshInterval} seconds`);
  console.log("====================");
}
