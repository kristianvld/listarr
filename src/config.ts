import { z } from "zod";

const ConfigSchema = z.object({
  letterboxd: z.array(z.string()).min(0).optional(),
  myanimelist: z.array(z.string()).min(0).optional(),
  discordWebhook: z.string().url().optional().nullable(),
  port: z.number().int().positive().optional(),
  refreshInterval: z.number().int().positive().optional(),
});

export type Config = z.infer<typeof ConfigSchema> & {
  letterboxd: string[];
  myanimelist: string[];
  discordWebhook?: string;
  port: number;
  refreshInterval: number;
};

function parseEnvArray(key: string): string[] | undefined {
  const value = process.env[key];
  if (!value) return undefined;
  // Support comma-separated or space-separated values
  return value.split(/[,\s]+/).filter((v) => v.trim().length > 0);
}

export async function loadConfig(): Promise<Config> {
  // Defaults
  const defaults = {
    letterboxd: [] as string[],
    myanimelist: [] as string[],
    discordWebhook: undefined as string | undefined,
    port: 3000,
    refreshInterval: 300,
  };

  // Load from config.json if it exists
  let configFileData: Partial<z.infer<typeof ConfigSchema>> = {};
  try {
    const configFile = Bun.file("config.json");
    if (await configFile.exists()) {
      const rawConfig = JSON.parse(await configFile.text());
      configFileData = ConfigSchema.parse(rawConfig);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Config validation error: ${error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`);
    }
    console.warn("[WARNING] Failed to load config.json, using defaults and environment variables only");
  }

  // Load from environment variables (highest priority)
  const envLetterboxd = parseEnvArray("LETTERBOXD_USERS");
  const envMyAnimeList = parseEnvArray("MYANIMELIST_USERS");
  const envDiscordWebhook = process.env.DISCORD_WEBHOOK;
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  const envRefreshInterval = process.env.REFRESH_INTERVAL ? parseInt(process.env.REFRESH_INTERVAL, 10) : undefined;

  // Merge: env > config > defaults
  const config: Config = {
    letterboxd: envLetterboxd ?? configFileData.letterboxd ?? defaults.letterboxd,
    myanimelist: envMyAnimeList ?? configFileData.myanimelist ?? defaults.myanimelist,
    discordWebhook: envDiscordWebhook ?? configFileData.discordWebhook ?? defaults.discordWebhook,
    port: envPort ?? configFileData.port ?? defaults.port,
    refreshInterval: envRefreshInterval ?? configFileData.refreshInterval ?? defaults.refreshInterval,
  };

  return config;
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
