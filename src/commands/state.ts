import * as path from "node:path";
import {
  readWorkflowState,
  writeWorkflowState,
  clearWorkflowState,
  getLocalJocDir,
  type WorkflowState,
} from "../agent/state";

export interface ExtendedWorkflowState extends WorkflowState {
  handoff_from?: string;
}

const allowedSkills = ["deep-interview", "ralplan", "team", "ultragoal"] as const;
type Skill = typeof allowedSkills[number];

function isSkill(val: string): val is Skill {
  return allowedSkills.includes(val as Skill);
}

const allowedVerbs = ["read", "write", "clear", "handoff"] as const;
type Verb = typeof allowedVerbs[number];

function isVerb(val: string): val is Verb {
  return allowedVerbs.includes(val as Verb);
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  joc state <skill> read [--json]");
  console.log("  joc state <skill> write --input '<json>' [--json]");
  console.log("  joc state <skill> clear");
  console.log("  joc state <skill> handoff --to <skill> [--json]");
  console.log("");
  console.log("Skills:");
  console.log("  deep-interview, ralplan, team, ultragoal");
  console.log("");
  console.log("Verbs:");
  console.log("  read, write, clear, handoff");
}

export async function runStateCommand(args: string[] = []): Promise<void> {
  const cwd = process.cwd();

  const isHelp = args.includes("--help") || args.includes("-h");
  if (isHelp) {
    printUsage();
    process.exitCode = 0;
    return;
  }

  if (args.length < 2) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const skill = args[0];
  const verb = args[1];

  if (!isSkill(skill) || !isVerb(verb)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const isJson = args.includes("--json");

  if (verb === "read") {
    const state = await readWorkflowState(skill, cwd);
    if (!state) {
      console.log(`No state found for skill: ${skill}`);
      return;
    }
    if (isJson) {
      console.log(JSON.stringify(state, null, 2));
    } else {
      const statePath = path.join(getLocalJocDir(cwd), "state", `${skill}-state.json`);
      console.log(`Skill: ${state.skill}`);
      console.log(`Current Phase: ${state.current_phase}`);
      console.log(`File Path: ${statePath}`);
      console.log("Details:");
      for (const [key, val] of Object.entries(state)) {
        if (key !== "skill" && key !== "current_phase") {
          console.log(`  ${key}: ${typeof val === "object" ? JSON.stringify(val) : val}`);
        }
      }
    }
    return;
  }

  if (verb === "write") {
    let inputJson: string | null = null;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--input") {
        inputJson = args[i + 1] || null;
        i++;
      } else if (args[i].startsWith("--input=")) {
        inputJson = args[i].substring("--input=".length);
      }
    }

    if (inputJson === null) {
      console.log("[ERROR] --input option is required for write verb.");
      process.exitCode = 1;
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(inputJson);
    } catch (err) {
      console.log(`[ERROR] Malformed JSON input: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.log("[ERROR] Input must be a valid JSON object.");
      process.exitCode = 1;
      return;
    }

    const existing = await readWorkflowState(skill, cwd);
    const merged: WorkflowState = {
      active: false,
      current_phase: "",
      ...existing,
      ...parsed,
      skill,
    };

    const statePath = await writeWorkflowState(skill, merged, cwd);
    if (isJson) {
      console.log(`State path: ${statePath}`);
      console.log(JSON.stringify(merged, null, 2));
    } else {
      console.log(`State path: ${statePath}`);
    }
    return;
  }

  if (verb === "clear") {
    await clearWorkflowState(skill, cwd);
    console.log(`Cleared state for skill: ${skill}`);
    return;
  }

  if (verb === "handoff") {
    let toSkill: string | null = null;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--to") {
        toSkill = args[i + 1] || null;
        i++;
      } else if (args[i].startsWith("--to=")) {
        toSkill = args[i].substring("--to=".length);
      }
    }

    if (!toSkill || !isSkill(toSkill)) {
      console.log(`[ERROR] Target skill must be specified with --to <skill>. Allowed skills: ${allowedSkills.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    const sourceState = await readWorkflowState(skill, cwd) || {
      active: false,
      current_phase: "",
      skill,
    };
    sourceState.current_phase = "handoff";
    const sourcePath = await writeWorkflowState(skill, sourceState, cwd);

    const targetState = await readWorkflowState(toSkill, cwd) || {
      active: false,
      current_phase: "",
      skill: toSkill,
    };
    const updatedTarget: ExtendedWorkflowState = {
      ...targetState,
      active: true,
      handoff_from: skill,
    };
    const targetPath = await writeWorkflowState(toSkill, updatedTarget, cwd);

    if (isJson) {
      console.log(JSON.stringify({
        source: { path: sourcePath, state: sourceState },
        target: { path: targetPath, state: updatedTarget }
      }, null, 2));
    } else {
      console.log(`Handoff completed.`);
      console.log(`Source (${skill}) state updated: ${sourcePath}`);
      console.log(`Target (${toSkill}) state updated: ${targetPath}`);
    }
    return;
  }
}
