import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { rexConfigCheck, rexConfigReload, type RexConfigCheck } from "./rexCli.js";
import { REX_RESUME_RULE_NAME, rexResumeTrustRule } from "./rexResume.js";
import { resumeDataDirArgs, resumeRecordArgv } from "./terminal/rex.js";

export const REX_RULE_OPEN = "-- >>> hive resume rule (managed by hive setup --rex-resume --install)";
export const REX_RULE_CLOSE = "-- <<< hive resume rule";
export const REX_RULE_INSTALL = "hive setup --rex-resume --install";
export const REX_RULE_UNINSTALL = "hive setup --rex-resume --uninstall";

const UNMARKED_RULE = new RegExp(`resume\\.trust\\.${REX_RESUME_RULE_NAME}["']`);

export class RexRuleRefusal extends Error {
  constructor(message: string, readonly printed: string[] = []) {
    super(message);
  }
}

type Word = string | { match: string };

function expectedCommand(): Word[] {
  const words: Word[] = resumeRecordArgv(0);
  words[words.length - 1 - resumeDataDirArgs().length] = { match: "id" };
  return words;
}

const show = (word: unknown): string => (typeof word === "string" ? word : JSON.stringify(word));

function sameWord(actual: unknown, expected: Word): boolean {
  if (typeof expected === "string") return actual === expected;
  return typeof actual === "object" && actual !== null && (actual as { match?: unknown }).match === expected.match;
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

interface AccountConfig {
  path: string;
  target: string;
  original: Buffer | null;
  text: string;
  mode: number;
  broken: string | null;
}

function accountConfig(): AccountConfig {
  let check: RexConfigCheck;
  try {
    check = rexConfigCheck();
  } catch (err) {
    throw new RexRuleRefusal(`could not find Rex's init.lua: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof check.report.path !== "string" || !check.report.path) throw new RexRuleRefusal("rex config check --json named no config path");
  const path = check.report.path;
  let target = path;
  if (existsSync(path) || isSymlink(path)) {
    try {
      target = realpathSync(path);
    } catch {
      throw new RexRuleRefusal(`${path} is a symlink to ${readlinkSync(path)}, which does not exist; point it at a real file or remove it, then re-run`);
    }
  }
  const original = existsSync(target) ? readFileSync(target) : null;
  return {
    path,
    target,
    original,
    text: original?.toString("utf8") ?? "",
    mode: original ? statSync(target).mode & 0o7777 : 0o644,
    broken: check.status !== 0 ? diagnosticsText(check.report) : null,
  };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

interface Layout {
  eol: string;
  lines: string[];
  block: { open: number; close: number } | null;
}

function markers(kind: string, at: number[]): string {
  if (at.length === 0) return `no ${kind} marker`;
  return `${kind} marker${at.length > 1 ? "s" : ""} on line${at.length > 1 ? "s" : ""} ${at.map((i) => i + 1).join(", ")}`;
}

function layout(config: AccountConfig): Layout {
  const eol = config.text.includes("\r\n") ? "\r\n" : "\n";
  const lines = config.text.split(/\r?\n/);
  const opens: number[] = [];
  const closes: number[] = [];
  lines.forEach((line, i) => {
    if (line.trimEnd() === REX_RULE_OPEN) opens.push(i);
    else if (line.trimEnd() === REX_RULE_CLOSE) closes.push(i);
  });
  if (opens.length === 0 && closes.length === 0) return { eol, lines, block: null };
  if (opens.length === 1 && closes.length === 1 && opens[0]! < closes[0]!) return { eol, lines, block: { open: opens[0]!, close: closes[0]! } };
  throw new RexRuleRefusal(
    `${config.path}: hive's marker lines do not pair up (${markers("open", opens)}, ${markers("close", closes)}), so hive cannot tell which lines it manages; ` +
      `fix them by hand so one "${REX_RULE_OPEN}" line sits above one "${REX_RULE_CLOSE}" line, or neither remains, then re-run`,
  );
}

function outsideBlock({ lines, block }: Layout): string[] {
  return block ? [...lines.slice(0, block.open), ...lines.slice(block.close + 1)] : lines;
}

function withBlock(at: Layout, blockLines: string[]): string {
  const lines = [...at.lines];
  if (at.block) lines.splice(at.block.open, at.block.close - at.block.open + 1, ...blockLines);
  else {
    if (lines[lines.length - 1] === "") lines.pop();
    lines.push(...(lines.length > 0 ? [""] : []), ...blockLines, "");
  }
  return lines.join(at.eol);
}

function withoutBlock(at: Layout & { block: { open: number; close: number } }): string {
  const lines = [...at.lines];
  const gap = at.block.open > 0 && lines[at.block.open - 1] === "" ? 1 : 0;
  lines.splice(at.block.open - gap, at.block.close - at.block.open + 1 + gap);
  return lines.join(at.eol);
}

function writeDurably(file: string, data: string | Buffer, mode: number): void {
  const fd = openSync(file, "w", mode);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(file, mode);
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

function validateAndWrite(config: AccountConfig, candidate: string, install: boolean): string[] {
  const dir = dirname(config.target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(config.target)}.hive-${process.pid}.tmp`);
  const backup = `${config.target}.hive-bak`;
  try {
    writeDurably(tmp, candidate, config.mode);
    let check: RexConfigCheck;
    try {
      check = rexConfigCheck(tmp);
    } catch (err) {
      throw new RexRuleRefusal(`rex config check could not read the edited file: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (check.status !== 0) {
      throw new RexRuleRefusal(
        config.broken !== null
          ? `${config.path} already has errors:\n${config.broken}\nfix them first, then re-run`
          : `rex config check reports errors in the edited file, so ${config.path} is unchanged:\n${diagnosticsText(check.report)}`,
      );
    }
    if (install) {
      const detail = ruleDifference(hiveRule(check.report)?.rule?.command);
      if (detail) throw new RexRuleRefusal(`the edited file's ${REX_RESUME_RULE_NAME} rule did not read back as hive's command (${detail}), so ${config.path} is unchanged`);
    }
    if (!sameBytes(existsSync(config.target) ? readFileSync(config.target) : null, config.original)) {
      throw new RexRuleRefusal(`${config.path} changed while hive was checking it, so hive left it as it is; re-run once nothing else is editing it`);
    }
    if (config.original) writeDurably(backup, config.original, config.mode);
    renameSync(tmp, config.target);
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {}
  return config.original ? [`The previous file is kept at ${backup}.`] : [];
}

function reload(done: string[]): string[] {
  try {
    rexConfigReload();
  } catch (err) {
    throw new RexRuleRefusal(
      `init.lua is written, but rex config reload failed: ${err instanceof Error ? err.message : String(err)}. Rex reads it when it next starts; to load it now, start the server and re-run: ${REX_RULE_INSTALL}`,
      done,
    );
  }
  return [...done, "Rex reloaded its config."];
}

export function installRexResumeRule(): string[] {
  const config = accountConfig();
  const at = layout(config);
  if (outsideBlock(at).some((line) => UNMARKED_RULE.test(line))) {
    throw new RexRuleRefusal(`${config.path} sets resume.trust.${REX_RESUME_RULE_NAME} in lines not managed by hive; remove it first, then run: ${REX_RULE_INSTALL}`);
  }
  const text = withBlock(at, [REX_RULE_OPEN, ...rexResumeTrustRule().split("\n"), REX_RULE_CLOSE]);
  if (text === config.text) {
    reload([]);
    return [`hive's resume rule in ${config.path} is already current; reloaded.`, `Remove it with: ${REX_RULE_UNINSTALL}`];
  }
  const written = validateAndWrite(config, text, true);
  return [
    ...reload([`Installed hive's resume rule in ${config.path}, between the lines`, `  ${REX_RULE_OPEN}`, `  ${REX_RULE_CLOSE}`, ...written]),
    "A hive block launched with a resume record naming another command resumes only once it is relaunched.",
    `Remove it with: ${REX_RULE_UNINSTALL}`,
  ];
}

export function uninstallRexResumeRule(): string[] {
  const config = accountConfig();
  const at = layout(config);
  const unmarked = outsideBlock(at).some((line) => UNMARKED_RULE.test(line))
    ? [`${config.path} still sets resume.trust.${REX_RESUME_RULE_NAME} in lines hive does not manage; remove those by hand.`]
    : [];
  if (!at.block) return [`No hive-managed resume rule in ${config.path}; nothing to remove.`, ...unmarked];
  const written = validateAndWrite(config, withoutBlock({ ...at, block: at.block }), false);
  return [...reload([`Removed hive's resume rule from ${config.path}.`, ...written]), ...unmarked];
}
