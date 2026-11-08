import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateCustomMetadataDir, validateHostedApiKey, validateHostedUrl } from '../gateway/config.js';
import { checkCustomMetadataDir } from './checks.js';
import { EnvFileError, quoteEnvValue, renderEnvFile } from './envFile.js';
import { createPrompt, PromptEndedError, type Prompt } from './prompt.js';

export type SetupMode = 'local' | 'hosted';

/** What a finished deployment hands to setup: the new server's MCP URL and the deployer's developer key. */
export interface DeployResult {
  hostedUrl: string;
  key: string;
}

/** A deployment that has been asked for and confirmed, but not started. */
export interface DeployPlan {
  run(): Promise<DeployResult>;
}

/**
 * The deploy walkthrough (operator package only, `src/cli/deploy.ts`). Setup asks its questions first, closes its
 * prompt, and only then runs the plan, because the deploy scripts read the terminal themselves.
 */
export interface DeployRunner {
  /** Asks the deploy questions; null when the user declines at the confirmation. */
  ask(prompt: Prompt, output: NodeJS.WritableStream): Promise<DeployPlan | null>;
  /** The same plan from flags alone (`--yes` and every value); throws an `Error` whose message names the problem. */
  fromFlags(flags: Readonly<Record<string, string | boolean>>): Promise<DeployPlan>;
}

/** Which package runs setup: its command name, and the deploy walkthrough when it has one. */
export interface SetupEdition {
  bin: string;
  deploy?: DeployRunner;
}

export const OPERATOR_BIN = 'd365-fno-mcp-server';
export const DEVELOPER_BIN = 'd365-fno-mcp';

export interface SetupOptions {
  nonInteractive: boolean;
  /** `local` or `hosted`; interactive setup asks when it is not given. Validated by `setupCommand`. */
  mode?: string;
  /** Local mode: where to keep the custom index (`D365_LOCAL_INDEX_DB_PATH`); blank for the default. */
  indexPath?: string;
  hostedUrl?: string;
  hostedApiKey?: string;
  hostedApiKeyFile?: string;
  /** Hosted mode: deploy a new server instead of connecting to one. */
  deploy?: boolean;
  customDir?: string;
  /** Flags of the old full-local-index mode that were given; each is refused by name. */
  removedFlags?: string[];
  /** Every flag as parsed, for the deploy walkthrough's own flags. */
  flags?: Readonly<Record<string, string | boolean>>;
  cwd?: string;
  /** Replace an existing `.env`; without it setup refuses to overwrite one. */
  force?: boolean;
  /** Prompt streams, for tests. Both default to the process's own. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Forces readline's terminal mode on or off; derived from `input` when omitted. */
  terminal?: boolean;
  /** Runs the checks offered after the `.env` is written, with an environment built from the answers only. */
  runDoctor?: (env: NodeJS.ProcessEnv) => Promise<number>;
  /** Defaults to the operator package without the deploy walkthrough. */
  edition?: SetupEdition;
}

type KeyChoice = { key: string } | { keyFile: string };

interface LocalAnswers {
  mode: 'local';
  customDir: string;
  /** As it goes into the `.env`; empty for the default. */
  indexPath: string;
}

interface HostedAnswers {
  mode: 'hosted';
  hostedUrl: string;
  key: KeyChoice;
  customDir: string;
}

type Answers = LocalAnswers | HostedAnswers;

/** The answers, or for a deployment the plan that produces the URL and key once the prompt is closed. */
type Pending = Answers | { mode: 'deploy'; plan: DeployPlan; customDir: string };

interface Collected {
  pending: Pending;
  runChecks: boolean;
}

/** The flags of the full-local-index mode, which setup no longer offers. */
const REMOVED_FLAGS = ['packages-dir', 'api-key', 'db-path', 'transport', 'host'] as const;

/** The flags only one mode uses, as written on the command line. */
const LOCAL_ONLY_FLAGS = [['--index-path', 'indexPath']] as const;
const HOSTED_ONLY_FLAGS = [
  ['--hosted-url', 'hostedUrl'],
  ['--hosted-api-key', 'hostedApiKey'],
  ['--hosted-api-key-file', 'hostedApiKeyFile'],
  ['--deploy', 'deploy'],
] as const;
/**
 * Flags that take a value. A bare one is a typo (often an unset shell variable that left the word out), and
 * `parseArgs` would hand it over as `true` for the code to read as "not given".
 */
const VALUE_FLAGS = ['mode', 'index-path', 'hosted-url', 'hosted-api-key', 'hosted-api-key-file', 'custom-dir'] as const;

const FLAG_FOR_VARIABLE: Readonly<Record<string, string>> = {
  D365_HOSTED_MCP_URL: '--hosted-url',
  D365_HOSTED_API_KEY: '--hosted-api-key',
  D365_HOSTED_API_KEY_FILE: '--hosted-api-key-file',
  D365_CUSTOM_METADATA_DIR: '--custom-dir',
};

/** A problem with what the developer asked for, worded to print as is. */
class SetupError extends Error {}

function fail(message: string): never {
  throw new SetupError(message);
}

/** Why a flag of the old full-local-index mode is refused. */
export function removedFlagMessage(flag: string): string {
  return `--${flag} is no longer supported: setup no longer builds a full local index. Use --mode local (custom models only) or --mode hosted.`;
}

/** What the developer package says when asked to deploy. */
export function deployNeedsOperatorMessage(): string {
  return (
    'Deploying a hosted server needs the operator package and Owner (or Contributor and User Access Administrator) on the Azure subscription. ' +
    `Run: npx ${OPERATOR_BIN} setup --mode hosted --deploy`
  );
}

/**
 * Translates parsed command-line flags into setup options, or says what is wrong with them. Kept apart from
 * `src/index.ts` (which cannot be imported without running the CLI) so it can be tested.
 */
export function parseSetupFlags(
  flags: Readonly<Record<string, string | boolean>>
): { options: SetupOptions } | { error: string } {
  const nonInteractive = flags['non-interactive'];
  // `--non-interactive hosted` makes parseArgs read "hosted" as the flag's value, and setup would turn interactive.
  if (typeof nonInteractive === 'string' && nonInteractive !== 'true' && nonInteractive !== 'false') {
    return { error: `--non-interactive does not take a value, but "${nonInteractive}" follows it. Put it last or write --non-interactive=true.` };
  }
  const bare = VALUE_FLAGS.find((name) => flags[name] === true);
  if (bare) return { error: `--${bare} needs a value.` };
  const deploy = flags.deploy;
  if (typeof deploy === 'string' && deploy !== 'true' && deploy !== 'false') {
    return { error: `--deploy does not take a value, but "${deploy}" follows it. Put it last or write --deploy=true.` };
  }

  const text = (name: string): string | undefined => {
    const value = flags[name];
    return typeof value === 'string' ? value : undefined;
  };
  const removedFlags = REMOVED_FLAGS.filter((name) => flags[name] !== undefined);
  return {
    options: {
      nonInteractive: nonInteractive === true || nonInteractive === 'true',
      mode: text('mode'),
      indexPath: text('index-path'),
      hostedUrl: text('hosted-url'),
      hostedApiKey: text('hosted-api-key'),
      hostedApiKeyFile: text('hosted-api-key-file'),
      deploy: deploy === true || deploy === 'true' ? true : undefined,
      customDir: text('custom-dir'),
      force: flags.force === true || flags.force === 'true',
      ...(removedFlags.length > 0 ? { removedFlags } : {}),
      flags,
    },
  };
}

/** A pasted path as typed: trimmed, one pair of surrounding quotes removed (Explorer's "Copy as path" adds them), `~/` expanded. */
export function cleanPathAnswer(answer: string): string {
  let value = answer.trim();
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) value = value.slice(1, -1).trim();
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(1));
  return value;
}

/** A pasted path made absolute against `cwd`; a blank answer stays blank. Checks and `.env` values both start here. */
export function normalizePathAnswer(answer: string, cwd: string): string {
  const value = cleanPathAnswer(answer);
  return value === '' ? '' : path.resolve(cwd, value);
}

/**
 * A validator's problem in plain words, for a prompt or a flag: the validators speak in environment variable
 * names and error codes. `shown` is the path that was checked (never a key), named in the message when given.
 */
function plainReason(check: { variable: string; message: string }, shown?: string): string {
  const { variable, message } = check;
  const code = /\((E[A-Z]+)\)/.exec(message)?.[1];
  const quoted = shown === undefined ? 'That' : `"${shown}"`;
  if (variable === 'D365_HOSTED_MCP_URL') {
    if (message.startsWith('is required')) return 'A hosted MCP URL is required, for example https://<your-app>.azurewebsites.net/mcp.';
    if (message.includes('absolute URL')) return 'That is not a full URL. It looks like https://<your-app>.azurewebsites.net/mcp.';
    if (message.includes('must use https')) return 'Use an https:// URL; http:// is accepted only for localhost.';
    if (message.includes('credentials')) return 'Leave the user name and password out of the URL and give the key separately.';
  } else if (variable === 'D365_HOSTED_API_KEY') {
    if (message.startsWith('is required')) return 'A hosted API key is required.';
    if (message.includes('printable ASCII')) return 'The key can hold only letters, digits and symbols, with no spaces or line breaks.';
  } else if (variable === 'D365_HOSTED_API_KEY_FILE') {
    // The path is never repeated here: a key given where a path belongs would be echoed back into a log.
    if (code === 'ENOENT') return 'There is no file at that path.';
    if (code === 'EISDIR') return 'That is a folder, not a file.';
    if (code === 'ENOTDIR') return 'Part of that path is a file, not a folder.';
    if (code === 'EACCES' || code === 'EPERM') return 'That file cannot be read (permission denied).';
    if (message.includes('empty')) return 'That file is empty.';
    if (message.includes('printable ASCII')) return 'The file must hold just the key, on one line, with no spaces.';
    if (code) return `That file cannot be read (${code}).`;
  } else if (variable === 'D365_CUSTOM_METADATA_DIR') {
    if (message.startsWith('is required')) return 'A folder is required.';
    if (message.startsWith('directory does not exist')) return shown === undefined ? 'There is no such folder.' : `There is no folder at "${shown}".`;
    if (message.startsWith('Not a directory')) return `${quoted} is a file, not a folder.`;
  }
  // What the file system said, for the folder checks that pass its error through.
  const errno = /^(E[A-Z]+):/.exec(message)?.[1];
  if (errno === 'ENOTDIR') return 'Part of that path is a file, not a folder.';
  if (errno) return `${quoted} cannot be used (${errno}).`;
  return `${message.charAt(0).toUpperCase()}${message.slice(1)}${message.endsWith('.') ? '' : '.'}`;
}

/** The reason for a refused flag: the flag, a colon and the plain reason, so every line reads the same way. */
function flagProblem(check: { variable: string; message: string }, shown?: string): string {
  return `${FLAG_FOR_VARIABLE[check.variable] ?? check.variable}: ${plainReason(check, shown)}`;
}

/** `.env` files cannot hold a line break or a control character, nor a value that needs a quoting they lack. */
function unwritableReason(value: string): string | undefined {
  return quoteEnvValue(value) === null
    ? 'That cannot be saved in a .env file: it holds a line break or control character, or an unusual mix of quotes.'
    : undefined;
}

function nearestExisting(target: string): string {
  let existing = target;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  return existing;
}

/** The index DB must be a file that can be created: not an existing folder, and under a folder that exists or can be made. */
function dbPathProblem(answer: string, cwd: string): string | undefined {
  const file = normalizePathAnswer(answer, cwd);
  if (file === '') return 'An index path is required.';
  try {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      return `"${file}" is a folder. Give a file name, for example ${path.join(file, 'custom_index.db')}.`;
    }
    const dir = path.dirname(file);
    const existing = nearestExisting(dir);
    // On Windows the walk upwards ends at a drive root, and a drive or share that is not there never exists.
    if (!fs.existsSync(existing)) return `The drive or share of "${file}" does not exist.`;
    if (!fs.statSync(existing).isDirectory()) return `"${dir}" cannot be created: "${existing}" is not a folder.`;
    try {
      fs.accessSync(existing, fs.constants.W_OK);
    } catch {
      return `"${dir}" cannot be created: you cannot write in "${existing}".`;
    }
    return unwritableReason(cleanPathAnswer(answer));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return `"${file}" cannot be used${code ? ` (${code})` : ''}.`;
  }
}

async function askYesNo(prompt: Prompt, question: string, fallback: boolean): Promise<boolean> {
  const answer = await prompt.ask(`${question} [${fallback ? 'Y/n' : 'y/N'}]`, {
    validate: (value) => (value === '' || /^(y|yes|n|no)$/i.test(value) ? undefined : 'Answer y or n.'),
  });
  return answer === '' ? fallback : /^y/i.test(answer);
}

async function askChoice(prompt: Prompt, output: NodeJS.WritableStream, text: string): Promise<'1' | '2'> {
  output.write(text);
  const answer = await prompt.ask('Choose 1 or 2', {
    default: '1',
    validate: (value) => (value === '1' || value === '2' ? undefined : 'Answer 1 or 2.'),
  });
  return answer === '2' ? '2' : '1';
}

async function askMode(prompt: Prompt, output: NodeJS.WritableStream): Promise<SetupMode> {
  const choice = await askChoice(
    prompt,
    output,
    'How will you use it?\n' +
      '  1) Local only: index my custom models here. No hosted server.\n' +
      '  2) Hosted: a hosted server for the standard application, plus my custom models indexed here.\n'
  );
  return choice === '2' ? 'hosted' : 'local';
}

async function askDeployed(prompt: Prompt, output: NodeJS.WritableStream): Promise<boolean> {
  const choice = await askChoice(
    prompt,
    output,
    'Is the hosted server already deployed?\n' +
      '  1) Yes: I have its URL and a developer key.\n' +
      '  2) No: deploy one now.\n'
  );
  return choice === '1';
}

/** The folder with the custom models, checked as it is typed. */
async function askCustomDir(prompt: Prompt, cwd: string): Promise<string> {
  let notice: string | undefined;
  const dirAnswer = await prompt.ask('Folder with your custom models', {
    validate: async (answer) => {
      const dir = normalizePathAnswer(answer, cwd);
      if (dir === '') return 'A folder is required.';
      const check = validateCustomMetadataDir(dir);
      if (!check.ok) return plainReason(check, dir);
      const unwritable = unwritableReason(dir);
      if (unwritable) return unwritable;
      const layout = await checkCustomMetadataDir(dir);
      notice = layout.status === 'warn' ? layout.message : undefined;
      return layout.status === 'fail' ? layout.message : undefined;
    },
  });
  // A folder that holds no models yet is legitimate; say so and go on.
  if (notice) console.warn(`Warning: ${notice}`);
  return normalizePathAnswer(dirAnswer, cwd);
}

async function collectLocalInteractive(prompt: Prompt, cwd: string): Promise<Collected> {
  const customDir = await askCustomDir(prompt, cwd);
  const indexAnswer = await prompt.ask('Where to keep the local index (blank for ./.d365/custom_index.db)', {
    validate: (answer) => (answer.trim() === '' ? undefined : dbPathProblem(answer, cwd)),
  });
  const runChecks = await askYesNo(prompt, 'Run the checks now?', true);
  return { pending: { mode: 'local', customDir, indexPath: cleanPathAnswer(indexAnswer) }, runChecks };
}

async function askHostedConnection(prompt: Prompt, cwd: string): Promise<{ hostedUrl: string; key: KeyChoice }> {
  let hostedUrl = '';
  await prompt.ask('Hosted MCP URL', {
    validate: (answer) => {
      const check = validateHostedUrl(answer);
      if (!check.ok) return plainReason(check);
      hostedUrl = check.value;
      return unwritableReason(hostedUrl);
    },
  });

  const source = await prompt.ask('Developer key: type it (k) or read it from a file (f)', {
    default: 'k',
    validate: (answer) => (/^[kf]$/i.test(answer) ? undefined : 'Answer k or f.'),
  });
  if (/^f$/i.test(source)) {
    const fileAnswer = await prompt.ask('Developer key file', {
      validate: (answer) => {
        const file = normalizePathAnswer(answer, cwd);
        if (file === '') return 'A key file path is required.';
        const check = validateHostedApiKey({ keyFile: file });
        return check.ok ? unwritableReason(file) : plainReason(check, file);
      },
    });
    return { hostedUrl, key: { keyFile: normalizePathAnswer(fileAnswer, cwd) } };
  }
  const typed = await prompt.ask('Developer key', {
    secret: true,
    validate: (answer) => {
      const check = validateHostedApiKey({ key: answer });
      return check.ok ? unwritableReason(answer) : plainReason(check);
    },
  });
  return { hostedUrl, key: { key: typed } };
}

async function collectHostedInteractive(
  prompt: Prompt,
  options: SetupOptions,
  edition: SetupEdition,
  cwd: string,
  output: NodeJS.WritableStream
): Promise<Collected | null> {
  const deployed = options.deploy ? false : options.hostedUrl !== undefined ? true : await askDeployed(prompt, output);
  if (!deployed) {
    if (!edition.deploy) fail(deployNeedsOperatorMessage());
    let plan: DeployPlan | null;
    try {
      plan = await edition.deploy.ask(prompt, output);
    } catch (error) {
      if (error instanceof PromptEndedError) throw error;
      fail(error instanceof Error ? error.message : String(error));
    }
    if (plan === null) return null;
    const customDir = await askCustomDir(prompt, cwd);
    const runChecks = await askYesNo(prompt, 'Run the checks once it is deployed?', true);
    return { pending: { mode: 'deploy', plan, customDir }, runChecks };
  }
  const connection = await askHostedConnection(prompt, cwd);
  const customDir = await askCustomDir(prompt, cwd);
  const runChecks = await askYesNo(prompt, 'Run the checks now?', true);
  return { pending: { mode: 'hosted', ...connection, customDir }, runChecks };
}

async function collectInteractive(
  mode: SetupMode | undefined,
  options: SetupOptions,
  edition: SetupEdition,
  cwd: string,
  output: NodeJS.WritableStream
): Promise<Collected | null> {
  const prompt = createPrompt({ input: options.input, output, terminal: options.terminal });
  try {
    const chosen = mode ?? (await askMode(prompt, output));
    return chosen === 'hosted'
      ? await collectHostedInteractive(prompt, options, edition, cwd, output)
      : await collectLocalInteractive(prompt, cwd);
  } finally {
    prompt.close();
  }
}

/** The custom-models folder from `--custom-dir`, checked as the prompt checks it. */
async function customDirFromFlag(customDir: string | undefined, mode: string, cwd: string): Promise<string> {
  if (!customDir) fail(`--custom-dir is required with --mode ${mode} --non-interactive.`);
  const dir = normalizePathAnswer(customDir, cwd);
  const dirCheck = validateCustomMetadataDir(dir);
  if (!dirCheck.ok) fail(flagProblem(dirCheck, dir));
  const layout = await checkCustomMetadataDir(dir);
  if (layout.status === 'fail') fail(`--custom-dir: ${layout.message}`);
  if (layout.status === 'warn') console.warn(`Warning: ${layout.message}`);
  return dir;
}

/** Setup from flags alone, for scripts and CI. */
async function collectNonInteractive(mode: SetupMode, options: SetupOptions, edition: SetupEdition, cwd: string): Promise<Pending> {
  if (mode === 'local') {
    const customDir = await customDirFromFlag(options.customDir, 'local', cwd);
    const indexPath = options.indexPath === undefined ? '' : cleanPathAnswer(options.indexPath);
    if (indexPath !== '') {
      const problem = dbPathProblem(indexPath, cwd);
      if (problem) fail(`--index-path: ${problem}`);
    }
    return { mode: 'local', customDir, indexPath };
  }

  if (options.deploy) {
    if (!edition.deploy) fail(deployNeedsOperatorMessage());
    for (const flag of ['--hosted-url', '--hosted-api-key', '--hosted-api-key-file'] as const) {
      const field = flag === '--hosted-url' ? 'hostedUrl' : flag === '--hosted-api-key' ? 'hostedApiKey' : 'hostedApiKeyFile';
      if (options[field] !== undefined) fail(`${flag} does not apply to --deploy: the deployment makes the URL and your key.`);
    }
    const customDir = await customDirFromFlag(options.customDir, 'hosted', cwd);
    try {
      return { mode: 'deploy', plan: await edition.deploy.fromFlags(options.flags ?? {}), customDir };
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  const { hostedUrl, hostedApiKey, hostedApiKeyFile } = options;
  if (!hostedUrl) fail('--hosted-url (or --deploy) is required with --mode hosted --non-interactive.');
  if (hostedApiKey && hostedApiKeyFile) fail('Pass either --hosted-api-key or --hosted-api-key-file, not both.');
  if (!hostedApiKey && !hostedApiKeyFile) {
    fail('--hosted-api-key-file (or --hosted-api-key) is required with --mode hosted --non-interactive.');
  }
  const url = validateHostedUrl(hostedUrl);
  if (!url.ok) fail(flagProblem(url));
  const key: KeyChoice = hostedApiKeyFile
    ? { keyFile: normalizePathAnswer(hostedApiKeyFile, cwd) }
    : { key: hostedApiKey ?? '' };
  const keyCheck = validateHostedApiKey(key);
  if (!keyCheck.ok) fail(flagProblem(keyCheck, 'keyFile' in key ? key.keyFile : undefined));
  const customDir = await customDirFromFlag(options.customDir, 'hosted', cwd);
  return { mode: 'hosted', hostedUrl: url.value, key, customDir };
}

function envEntries(answers: Answers): Array<readonly [string, string]> {
  if (answers.mode === 'local') {
    return [
      ['D365_CUSTOM_METADATA_DIR', answers.customDir],
      ...(answers.indexPath ? ([['D365_LOCAL_INDEX_DB_PATH', answers.indexPath]] as const) : []),
    ];
  }
  return [
    ['D365_HOSTED_MCP_URL', answers.hostedUrl],
    'key' in answers.key
      ? ['D365_HOSTED_API_KEY', answers.key.key]
      : ['D365_HOSTED_API_KEY_FILE', answers.key.keyFile],
    ['D365_CUSTOM_METADATA_DIR', answers.customDir],
  ];
}

/** What a later `doctor` would read from the new `.env`, and nothing from the old one in `process.env`. */
function followUpEnv(answers: Answers, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of envEntries(answers)) env[name] = value;
  if (answers.mode === 'local' && answers.indexPath) env.D365_LOCAL_INDEX_DB_PATH = path.resolve(cwd, answers.indexPath);
  return env;
}

function header(bin: string, mode: SetupMode): string {
  return mode === 'local'
    ? `# Generated by \`${bin} setup\` (local mode: custom models only, no hosted server)`
    : `# Generated by \`${bin} setup\` (hosted server and custom models)`;
}

function nextStepLine(bin: string, doctorDone: boolean): string {
  const commands = doctorDone ? ['gateway'] : ['doctor', 'gateway'];
  return `Next: run ${commands.map((command) => `\`${bin} ${command}\``).join(', then ')}.`;
}

/** Runs a follow-up, turning a failure of any kind into `false`: the `.env` is already written and stays. */
async function runFollowUp(label: string, run: () => Promise<number>): Promise<boolean> {
  try {
    return (await run()) === 0;
  } catch (error) {
    console.error(`${label} could not run: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Refuses the flags that do not belong to the chosen mode, and those of the removed full-local-index mode. */
function refuseForeignFlags(mode: SetupMode | undefined, options: SetupOptions): void {
  const [removed] = options.removedFlags ?? [];
  if (removed) fail(removedFlagMessage(removed));
  if (mode === undefined) return;
  const foreign = mode === 'hosted' ? LOCAL_ONLY_FLAGS : HOSTED_ONLY_FLAGS;
  for (const [flag, field] of foreign) {
    if (options[field] === undefined) continue;
    fail(mode === 'hosted' ? `${flag} applies only to --mode local.` : `${flag} applies only to --mode hosted; add --mode hosted.`);
  }
}

/**
 * Writes a `.env` file: asks how the tool will be used (local only, or a hosted server plus the custom models,
 * deployed now or already there) and checks each answer as it is given, or takes everything from flags with
 * `nonInteractive`. Returns the exit code. Nothing is written when the input ends or is interrupted before the
 * questions are answered, or when a deployment fails.
 */
export async function setupCommand(options: SetupOptions): Promise<number> {
  const edition = options.edition ?? { bin: OPERATOR_BIN };
  const cwd = options.cwd ?? process.cwd();
  const envPath = path.resolve(cwd, '.env');
  if (fs.existsSync(envPath) && !options.force) {
    console.error(`${envPath} already exists; pass --force to replace it.`);
    return 1;
  }

  try {
    const requested = options.mode;
    if (requested !== undefined && requested !== 'local' && requested !== 'hosted') {
      fail('--mode must be "local" or "hosted".');
    }
    const impliedMode: SetupMode | undefined =
      requested ?? (options.deploy || options.hostedUrl !== undefined ? 'hosted' : undefined);
    refuseForeignFlags(impliedMode, options);
    if (options.nonInteractive && impliedMode === undefined) {
      fail('--mode is required with --non-interactive: --mode local (custom models only) or --mode hosted.');
    }

    let collected: Collected | null;
    try {
      if (options.nonInteractive && impliedMode !== undefined) {
        collected = { pending: await collectNonInteractive(impliedMode, options, edition, cwd), runChecks: false };
      } else {
        collected = await collectInteractive(impliedMode, options, edition, cwd, options.output ?? process.stdout);
      }
    } catch (error) {
      if (!(error instanceof PromptEndedError)) throw error;
      console.error(
        error.reason === 'interrupt'
          ? 'Setup was interrupted; nothing was written.'
          : 'Input ended before setup finished; nothing was written. To run without questions, pass --non-interactive with its flags (see --help).'
      );
      return error.reason === 'interrupt' ? 130 : 1;
    }
    if (collected === null) {
      console.log('Nothing was deployed and nothing was written.');
      return 1;
    }

    let answers: Answers;
    const { pending } = collected;
    if (pending.mode === 'deploy') {
      let deployed: DeployResult;
      try {
        deployed = await pending.plan.run();
      } catch (error) {
        fail(`The deployment did not finish: ${error instanceof Error ? error.message : String(error)} No .env was written.`);
      }
      answers = { mode: 'hosted', hostedUrl: deployed.hostedUrl, key: { key: deployed.key }, customDir: pending.customDir };
    } else {
      answers = pending;
    }

    // Rendered before anything is created, so a value that cannot be written leaves no file behind.
    const text = renderEnvFile(header(edition.bin, answers.mode), envEntries(answers));
    try {
      // `mode` only applies when the file is created; an old file must not stay readable while it holds the new keys.
      if (options.force && fs.existsSync(envPath)) fs.chmodSync(envPath, 0o600);
      // Without --force the file is created exclusively, so one that appeared while the questions were being answered survives.
      fs.writeFileSync(envPath, text, { mode: 0o600, flag: options.force ? 'w' : 'wx' });
      fs.chmodSync(envPath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(`${envPath} already exists; pass --force to replace it.`);
      fail(`Setup could not write its files: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(`Wrote ${envPath}`);

    let doctorDone = false;
    if (collected.runChecks) {
      const env = followUpEnv(answers, cwd);
      const runDoctor = options.runDoctor ?? defaultRunDoctor(edition);
      doctorDone = await runFollowUp('The checks', () => runDoctor(env));
      if (!doctorDone) console.warn('The checks reported problems above; .env was kept.');
      console.log('');
    }
    console.log(nextStepLine(edition.bin, doctorDone));
    return 0;
  } catch (error) {
    if (error instanceof SetupError || error instanceof EnvFileError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

function defaultRunDoctor(edition: SetupEdition): (env: NodeJS.ProcessEnv) => Promise<number> {
  return async (env) => {
    const { doctorCommand } = await import('./doctor.js');
    return doctorCommand(env, {
      showNext: false,
      bin: edition.bin,
      edition: edition.bin === DEVELOPER_BIN ? 'developer' : 'operator',
    });
  };
}
