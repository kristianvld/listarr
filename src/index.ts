import { loadConfig, printConfig } from "./config";
import { createServer, refreshData, sendDiscordErrorNotification, loadAllEntries, setAllEntries } from "./server";
import { idLookup } from "./id-lookup";

async function main() {
  const config = await loadConfig();
  printConfig(config);

  // Load ID lookup databases
  await idLookup.load();
  const loadErrors = idLookup.getLoadErrors();
  if (loadErrors.length > 0) {
    console.warn(`[WARNING] ID lookup service loaded with ${loadErrors.length} error(s):`);
    for (const error of loadErrors) {
      console.warn(`  - ${error}`);
    }
    // Send Discord notification for ID lookup failures
    await sendDiscordErrorNotification(config, "ID Lookup Database Load Failed", `Failed to load ${loadErrors.length} ID lookup database(s). The application will continue but some ID mappings may be unavailable.`, new Error(loadErrors.join("; ")));
  }

  // Load all existing entries from announced.jsonl
  const existingEntries = await loadAllEntries();
  setAllEntries(existingEntries);
  console.log(`Loaded ${existingEntries.length} existing entries from announced.jsonl`);

  // Initial data refresh
  await refreshData(config);

  // Start HTTP server
  createServer(config);

  // Set up periodic refresh
  const intervalMs = config.refreshInterval * 1000;
  setInterval(async () => {
    try {
      await refreshData(config);
    } catch (error) {
      console.error("[ERROR] Error during refresh:", error);
      await sendDiscordErrorNotification(config, "Refresh Failed", "An error occurred during the scheduled data refresh", error);
    }
  }, intervalMs);

  console.log(`Refresh interval: ${config.refreshInterval} seconds`);
}

main().catch(async (error) => {
  console.error("[FATAL] Fatal error:", error);

  // Try to send Discord notification for fatal errors
  try {
    const config = await loadConfig();
    await sendDiscordErrorNotification(config, "Fatal Error - Application Crashed", "The application encountered a fatal error and is shutting down.", error);
  } catch (discordError) {
    // If we can't send Discord notification, just log it
    console.error("[ERROR] Failed to send fatal error notification:", discordError);
  }

  process.exit(1);
});
