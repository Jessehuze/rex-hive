import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { rexConfigCheck, rexConfigReload, type RexConfigCheck } from "./rexCli.js";
import { REX_RESUME_RULE_NAME, rexResumeTrustRule } from "./rexResume.js";
import { resumeDataDirArgs, resumeRecordArgv } from "./terminal/rex.js";

export const REX_RULE_OPEN = "-- >>> hive resume rule (managed by hive setup --rex-resume --install)";
export const REX_RULE_CLOSE = "-- <<< hive resume rule";
export const REX_RULE_INSTALL = "hive setup --rex-resume --install";
export const REX_RULE_UNINSTALL = "hive setup --rex-resume --uninstall";

const MANAGED_BLOCK = new RegExp(`^${escape(REX_RULE_OPEN)}\\n[\\s\\S]*?^${escape(REX_RULE_CLOSE)}\\n?`, "gm");
const MANAGED_WITH_GAP = new RegExp(`(?:^\\n)?${MANAGED_BLOCK.source}`, "gm");
const UNMARKED_RULE = new RegExp(`resume\\.trust\\.${escape(REX_RESUME_RULE_NAME)}["']`);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class RexRuleRefusal extends Error {}

type Word = string | { match: string };

function expectedCommand(): Word[] {
  const words: Word[] = resumeRecordArgv(0);
  words[words.length - 1 - resumeDataDirArgs().length] = { match: "id" };
  return words;
}

const show = (word: unknown): string => (typeof word === "string" ? word : JSON.stringify(word));

function sameWord(actual: unknown, expected: Word): boolean {
  if (typeof expected === "string") return actual === expected;
  return typeof actual === "object" && actual !== null && typeof (actual as { match?: unknown }).match === "string";
}

export function ruleDifference(actual: unknown, expected: Word[] = expectedCommand()): string | null {
  if (!Array.isArray(actual)) return "a command that is not a list";
  const at = expected.findIndex((word, i) => !sameWord(actual[i], word));
  if (at >= 0) return at < actual.length ? `names ${show(actual[at])}` : `lacks ${show(expected[at])}`;
  return actual.length > expected.length ? `names ${show(actual[expected.length])}` : null;
}

function hiveRule(report: RexConfigCheck["report"]): { rule?: { command?: unknown } } | null {
  const rules = Array.isArray(report.resume_rules) ? report.resume_rules : [];
  return rules.find((r) => r && typeof r === "object" && r.name === REX_RESUME_RULE_NAME && r.built_in !== true) ?? null;
}

export type RuleState =
  | { state: "current"; path: string }
  | { state: "missing"; path: string }
  | { state: "stale"; path: string; detail: string }
  | { state: "unknown"; detail: string };

const pathOf = (report: RexConfigCheck["report"]): string => (typeof report.path === "string" ? report.path : "init.lua");

export function resumeRuleState(): RuleState {
  let check: RexConfigCheck;
  try {
    check = rexConfigCheck();
  } catch (err) {
    return { state: "unknown", detail: `rex config check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const rule = hiveRule(check.report);
  const path = pathOf(check.report);
  if (!rule) return { state: "missing", path };
  const detail = ruleDifference(rule.rule?.command);
  return detail ? { state: "stale", path, detail } : { state: "current", path };
}

function diagnosticsText(report: RexConfigCheck["report"]): string {
  const list = Array.isArray(report.diagnostics) ? report.diagnostics : [];
  return list.map((d) => `  ${d && typeof d === "object" && typeof d.message === "string" ? `${d.source ? `${d.source}: ` : ""}${d.message}` : JSON.stringify(d)}`).join("\n");
}

function accountConfig(): { path: string; target: string; text: string; mode: number } {
  let check: RexConfigCheck;
  try {
    check = rexConfigCheck();
  } catch (err) {
    throw new RexRuleRefusal(`could not find Rex's init.lua: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof check.report.path !== "string" || !check.report.path) throw new RexRuleRefusal("rex config check --json named no config path");
  const path = check.report.path;
  const target = existsSync(path) ? realpathSync(path) : path;
  const exists = existsSync(target);
  return { path, target, text: exists ? readFileSync(target, "utf8") : "", mode: exists ? statSync(target).mode & 0o7777 : 0o644 };
}

function replaceManaged(text: string, block: string | null): { text: string; found: boolean } {
  let found = false;
  const next = text.replace(block === null ? MANAGED_WITH_GAP : MANAGED_BLOCK, () => {
    const first = !found;
    found = true;
    return first && block !== null ? block : "";
  });
  if (found || block === null) return { text: next, found };
  return { text: `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}`, found };
}

function validateAndWrite(config: ReturnType<typeof accountConfig>, candidate: string, install: boolean): string[] {
  const dir = dirname(config.target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(config.target)}.hive-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, candidate, { mode: config.mode });
    chmodSync(tmp, config.mode);
    let check: RexConfigCheck;
    try {
      check = rexConfigCheck(tmp);
    } catch (err) {
      throw new RexRuleRefusal(`rex config check could not read the edited file: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (check.status !== 0) throw new RexRuleRefusal(`rex config check reports errors in the edited file, so ${config.path} is unchanged:\n${diagnosticsText(check.report)}`);
    if (install) {
      const detail = ruleDifference(hiveRule(check.report)?.rule?.command);
      if (detail) throw new RexRuleRefusal(`the edited file's ${REX_RESUME_RULE_NAME} rule did not read back as hive's command (${detail}), so ${config.path} is unchanged`);
    }
    renameSync(tmp, config.target);
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    rexConfigReload();
    return ["Rex reloaded its config."];
  } catch (err) {
    return [`! rex config reload failed (${err instanceof Error ? err.message : String(err)}); Rex reads the file when it next starts, or run: rex config reload`];
  }
}

export function installRexResumeRule(): string[] {
  const config = accountConfig();
  const block = `${REX_RULE_OPEN}\n${rexResumeTrustRule()}\n${REX_RULE_CLOSE}\n`;
  if (UNMARKED_RULE.test(config.text.replace(MANAGED_BLOCK, ""))) {
    throw new RexRuleRefusal(`${config.path} sets resume.trust.${REX_RESUME_RULE_NAME} in lines not managed by hive; remove it first, then run: ${REX_RULE_INSTALL}`);
  }
  const { text } = replaceManaged(config.text, block);
  if (text === config.text) return [`hive's resume rule in ${config.path} is already current.`, `Remove it with: ${REX_RULE_UNINSTALL}`];
  return [
    `Installed hive's resume rule in ${config.path}, between the lines`,
    `  ${REX_RULE_OPEN}`,
    `  ${REX_RULE_CLOSE}`,
    ...validateAndWrite(config, text, true),
    "A hive block launched with a resume record naming another command resumes only once it is relaunched.",
    `Remove it with: ${REX_RULE_UNINSTALL}`,
  ];
}

export function uninstallRexResumeRule(): string[] {
  const config = accountConfig();
  const { text, found } = replaceManaged(config.text, null);
  const unmarked = UNMARKED_RULE.test(text) ? [`${config.path} still sets resume.trust.${REX_RESUME_RULE_NAME} in lines hive does not manage; remove those by hand.`] : [];
  if (!found) return [`No hive-managed resume rule in ${config.path}; nothing to remove.`, ...unmarked];
  return [`Removed hive's resume rule from ${config.path}.`, ...validateAndWrite(config, text, false), ...unmarked];
}
