/**
 * Entry point.
 *
 * Starts the API, and the React app alongside it when it has been built, so
 * the whole thing is one process on the Mac mini.
 */

import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { checkBlender } from "./blender.js";
import { JobQueue } from "./jobs.js";
import { seedVehicles } from "./seeds.js";
import { FsStorage } from "./storage.js";
import { Workspace } from "./workspace.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = new FsStorage(config.workspace);
  await storage.init();

  const queue = new JobQueue();
  const workspace = new Workspace(config, storage, queue);
  const seeded = await seedVehicles(workspace);
  const app = await createApp(workspace, config);

  await app.listen({ host: config.host, port: config.port });

  const blender = await checkBlender(config.blenderPath);
  app.log.info(`workspace: ${config.workspace}`);
  if (seeded > 0) app.log.info(`seeded ${seeded} built-in truck definition(s)`);
  app.log.info(
    blender.available
      ? `blender: ${blender.path} (${blender.message})`
      : "blender: not found -- building skins works, reading .blend files does not",
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
