// src/types/playwriter.d.ts
// Declaration file to allow TypeScript to recognize the optional Playwriter CLI module.
// This is only needed for the example automation script in scripts/playwriter-apply.ts.
// The actual Playwriter package is expected to be installed globally or run via npx.

declare module "playwriter" {
  export class Playwriter {
    /** Connect to the running Chrome extension bridge */
    connect(): Promise<void>;
    /** Open a new page (tab) in the connected browser */
    newPage(): Promise<any>;
    /** Disconnect from the bridge */
    disconnect(): Promise<void>;
  }
}
