#!/usr/bin/env node
// claudebox - Run Claude Code in a sandbox

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const process = require("process");

// =============================================================================
// Utility Functions
// =============================================================================

function getRepoRoot(projectDir) {
	try {
		return execSync("git rev-parse --show-toplevel 2>/dev/null", {
			encoding: "utf8",
			cwd: projectDir,
		}).trim();
	} catch {
		return projectDir;
	}
}

function randomHex(length) {
	const chars = "0123456789abcdef";
	let result = "";
	for (let i = 0; i < length; i++) {
		result += chars[Math.floor(Math.random() * chars.length)];
	}
	return result;
}

function realpath(p) {
	return fs.realpathSync(p);
}

function pathExists(p) {
	try {
		fs.accessSync(p);
		return true;
	} catch {
		return false;
	}
}

function isDirectory(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function getTmpDir() {
	return process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
}

// =============================================================================
// Configuration
// =============================================================================

const CONFIG_DEFAULTS = {
	allowSshAgent: false,
	allowGpgAgent: false,
	allowXdgRuntime: false,
};

const SANDBOX_SSH_SOCK = "/tmp/ssh-agent.sock";

function getConfigPath() {
	const xdgConfig =
		process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, ".config");
	return path.join(xdgConfig, "claudebox", "config.json");
}

function loadConfig() {
	const configPath = getConfigPath();

	try {
		const content = fs.readFileSync(configPath, "utf8");
		const userConfig = JSON.parse(content);
		return { ...CONFIG_DEFAULTS, ...userConfig };
	} catch (err) {
		if (err.code !== "ENOENT") {
			console.error(
				`Warning: Failed to load config from ${configPath}: ${err.message}`,
			);
		}
		return { ...CONFIG_DEFAULTS };
	}
}

// =============================================================================
// Sandbox Interface
// =============================================================================

/**
 * Abstract sandbox interface.
 * Each platform implements this to provide process isolation.
 */
class Sandbox {
	constructor(config) {
		this.config = config;
	}

	/**
	 * Returns the command and arguments to execute a script in the sandbox.
	 * @param {string} script - The bash script to run
	 * @returns {{ cmd: string, args: string[], env: object }}
	 */
	wrap(_script) {
		throw new Error("Sandbox.wrap() must be implemented by subclass");
	}

	/**
	 * Spawn a process inside the sandbox.
	 * @param {string} script - The bash script to run
	 * @returns {ChildProcess}
	 */
	spawn(script) {
		const { cmd, args, env } = this.wrap(script);
		return spawn(cmd, args, { stdio: "inherit", env });
	}

	/**
	 * Print the sandbox command without executing it.
	 * @param {string} script - The bash script to run
	 */
	dryRun(script) {
		const { cmd, args, env } = this.wrap(script);
		const diffEnv = {};
		for (const [k, v] of Object.entries(env)) {
			if (process.env[k] !== v) diffEnv[k] = v;
		}
		for (const k of Object.keys(process.env)) {
			if (!(k in env)) diffEnv[k] = "(deleted)";
		}
		if (Object.keys(diffEnv).length > 0) {
			console.log("# Environment changes:");
			for (const [k, v] of Object.entries(diffEnv)) {
				console.log(`#   ${k}=${v}`);
			}
		}
		console.log(
			[cmd, ...args]
				.map((a) => (/[\s'"]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a))
				.join(" \\\n  "),
		);
	}

	/**
	 * Create the appropriate sandbox for the current platform.
	 * @param {object} config - Sandbox configuration
	 * @returns {Sandbox}
	 */
	static create(config) {
		const platform = process.platform;

		switch (platform) {
			case "linux":
				return new BubblewrapSandbox(config);
			case "darwin":
				return new SeatbeltSandbox(config);
			default:
				throw new Error(
					`Unsupported platform: ${platform}. Supported: linux, darwin (macOS)`,
				);
		}
	}
}

// =============================================================================
// Linux: Bubblewrap Sandbox
// =============================================================================

class BubblewrapSandbox extends Sandbox {
	wrap(script) {
		const {
			claudeHome,
			claudeConfig,
			claudeJson,
			shareTree,
			repoRoot,
			allowSshAgent,
			allowGpgAgent,
			allowXdgRuntime,
		} = this.config;

		const home = process.env.HOME;
		const user = process.env.USER;
		const pathEnv = process.env.PATH;

		const args = [
			// Basic filesystem
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"--ro-bind-try",
			"/usr",
			"/usr",
			"--ro-bind-try",
			"/bin",
			"/bin",
			"--ro-bind-try",
			"/lib",
			"/lib",
			"--ro-bind-try",
			"/lib64",
			"/lib64",
			"--ro-bind",
			"/etc",
			"/etc",

			// Selective /run mounts - avoid exposing /run/user/$UID (XDG runtime)
			"--ro-bind-try",
			"/run/systemd/resolve",
			"/run/systemd/resolve", // DNS resolver (stub-resolv.conf)
			"--ro-bind-try",
			"/run/current-system",
			"/run/current-system",
			"--ro-bind-try",
			"/run/booted-system",
			"/run/booted-system",
			"--ro-bind-try",
			"/run/opengl-driver",
			"/run/opengl-driver",
			"--ro-bind-try",
			"/run/opengl-driver-32",
			"/run/opengl-driver-32",
			"--ro-bind-try",
			"/run/nixos",
			"/run/nixos",
			"--ro-bind-try",
			"/run/wrappers",
			"/run/wrappers",

			// Nix store (read-only) and daemon socket (read-write)
			"--ro-bind",
			"/nix",
			"/nix",
			"--bind",
			"/nix/var/nix/daemon-socket",
			"/nix/var/nix/daemon-socket",
		];

		// Sanitize system ssh_config to remove Nix store Includes that fail
		// ownership checks inside the user namespace. This --ro-bind must come
		// after --ro-bind /nix so it partially overrides the Nix store mount.
		const sshConfigPath = "/etc/ssh/ssh_config";
		if (pathExists(sshConfigPath)) {
			try {
				const realSshConfig = fs.realpathSync(sshConfigPath);
				const content = fs.readFileSync(realSshConfig, "utf8");
				const sanitized = content.replace(
					/^Include\s+\/nix\/store\/.*$/gm,
					"",
				);
				const sanitizedPath = path.join(claudeHome, "ssh_config");
				fs.writeFileSync(sanitizedPath, sanitized);
				args.push("--ro-bind", sanitizedPath, realSshConfig);
			} catch {
				// Ignore errors sanitizing ssh_config
			}
		}

		args.push(

			// Isolated temp filesystem
			"--tmpfs",
			"/tmp",

			// Isolated home with Claude config mounted
			"--bind",
			claudeHome,
			home,
			"--bind",
			claudeConfig,
			path.join(home, ".claude"),
			"--bind",
			claudeJson,
			path.join(home, ".claude.json"),

			// Namespace isolation with network sharing
			"--unshare-all",
			"--share-net",

			// Environment variables
			"--setenv",
			"HOME",
			home,
			"--setenv",
			"USER",
			user,
			"--setenv",
			"PATH",
			pathEnv,
			"--setenv",
			"TMPDIR",
			"/tmp",
			"--setenv",
			"TEMPDIR",
			"/tmp",
			"--setenv",
			"TEMP",
			"/tmp",
			"--setenv",
			"TMP",
			"/tmp",
		);

		// Mount parent directory tree as read-only if needed
		if (shareTree !== repoRoot) {
			args.push("--ro-bind", shareTree, shareTree);
		}

		// Project directory gets full write access (YOLO mode)
		args.push("--bind", repoRoot, repoRoot);

		// XDG runtime directory access (opt-in)
		const xdgRuntimeDir =
			process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;

		if (allowXdgRuntime) {
			// Mount entire XDG runtime directory
			if (isDirectory(xdgRuntimeDir)) {
				args.push("--ro-bind", xdgRuntimeDir, xdgRuntimeDir);
				args.push("--setenv", "XDG_RUNTIME_DIR", xdgRuntimeDir);
			}
		} else if (allowGpgAgent) {
			const gpgDir = path.join(xdgRuntimeDir, "gnupg");
			if (isDirectory(gpgDir)) {
				args.push("--ro-bind", gpgDir, gpgDir);
			}
		}

		// SSH agent socket (independent of XDG runtime).
		// This --bind must come after --tmpfs /tmp so the socket overlays the tmpfs.
		if (allowSshAgent && process.env.SSH_AUTH_SOCK) {
			const sock = process.env.SSH_AUTH_SOCK;
			if (pathExists(sock)) {
				args.push("--bind", sock, SANDBOX_SSH_SOCK);
				args.push("--setenv", "SSH_AUTH_SOCK", SANDBOX_SSH_SOCK);
			}
		}

		// Remove SSH_AUTH_SOCK from inherited env to prevent leaking
		// the host path into the sandbox. It is set via --setenv when needed.
		const env = { ...process.env };
		delete env.SSH_AUTH_SOCK;

		// Add the script to execute
		args.push("bash", "-c", script);

		return {
			cmd: "bwrap",
			args,
			env,
		};
	}
}

// =============================================================================
// macOS: Seatbelt Sandbox (sandbox-exec)
// =============================================================================

class SeatbeltSandbox extends Sandbox {
	wrap(script) {
		const { repoRoot } = this.config;

		// Load base policy from environment
		const seatbeltProfile = process.env.CLAUDEBOX_SEATBELT_PROFILE;
		if (!seatbeltProfile || !pathExists(seatbeltProfile)) {
			throw new Error(
				"Seatbelt profile not found. Set CLAUDEBOX_SEATBELT_PROFILE environment variable.",
			);
		}

		const basePolicy = fs.readFileSync(seatbeltProfile, "utf8");

		// Canonicalize paths (macOS symlinks: /var -> /private/var, /tmp -> /private/tmp)
		const canonicalRepoRoot = realpath(repoRoot);
		const tmpdir = getTmpDir();
		const canonicalTmpdir = realpath(tmpdir);
		const canonicalSlashTmp = realpath("/tmp");

		// Build dynamic policy
		const writablePaths = [
			'(subpath (param "PROJECT_DIR"))',
			'(subpath (param "TMPDIR"))',
		];

		if (canonicalTmpdir !== canonicalSlashTmp) {
			writablePaths.push('(subpath (param "SLASH_TMP"))');
		}

		const dynamicPolicy = `
; Allow read-only file operations
(allow file-read*)

; Allow writes to project and temp directories
(allow file-write*
  ${writablePaths.join("\n  ")})

; Network access for Claude API
(allow network-outbound)
(allow network-inbound)
(allow system-socket)
`;

		const fullPolicy = basePolicy + "\n" + dynamicPolicy;

		// Build sandbox-exec arguments
		const args = [
			"-p",
			fullPolicy,
			`-DPROJECT_DIR=${canonicalRepoRoot}`,
			`-DTMPDIR=${canonicalTmpdir}`,
		];

		if (canonicalTmpdir !== canonicalSlashTmp) {
			args.push(`-DSLASH_TMP=${canonicalSlashTmp}`);
		}

		args.push("--", "bash", "-c", script);

		return {
			cmd: "/usr/bin/sandbox-exec",
			args,
			env: process.env,
		};
	}
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

function parseArgs(args) {
	// Load config file first
	const config = loadConfig();

	// CLI overrides - undefined means "not specified"
	const cliOverrides = {
		allowSshAgent: undefined,
		allowGpgAgent: undefined,
		allowXdgRuntime: undefined,
		dryRun: false,
	};

	let i = 0;
	while (i < args.length) {
		const arg = args[i];

		switch (arg) {
			case "--allow-ssh-agent":
				cliOverrides.allowSshAgent = true;
				i++;
				break;

			case "--allow-gpg-agent":
				cliOverrides.allowGpgAgent = true;
				i++;
				break;

			case "--allow-xdg-runtime":
				cliOverrides.allowXdgRuntime = true;
				i++;
				break;

			case "--dry-run":
				cliOverrides.dryRun = true;
				i++;
				break;

			case "-h":
			case "--help":
				showHelp();
				process.exit(0);
				break;

			default:
				console.error(`Unknown option: ${arg}`);
				console.error("Use --help for usage information");
				process.exit(1);
		}
	}

	// Merge: CLI overrides > config file > defaults
	const options = {
		allowSshAgent:
			cliOverrides.allowSshAgent !== undefined
				? cliOverrides.allowSshAgent
				: config.allowSshAgent,
		allowGpgAgent:
			cliOverrides.allowGpgAgent !== undefined
				? cliOverrides.allowGpgAgent
				: config.allowGpgAgent,
		allowXdgRuntime:
			cliOverrides.allowXdgRuntime !== undefined
				? cliOverrides.allowXdgRuntime
				: config.allowXdgRuntime,
		dryRun: cliOverrides.dryRun,
	};

	return options;
}

function showHelp() {
	const configPath = getConfigPath();
	console.log(`Usage: claudebox [OPTIONS]

Options:
  --allow-ssh-agent                       Allow access to SSH agent socket
  --allow-gpg-agent                       Allow access to GPG agent socket
  --allow-xdg-runtime                     Allow full XDG runtime directory access
  --dry-run                               Print sandbox command without executing
  -h, --help                              Show this help message

Configuration:
  Settings can be configured in ${configPath}
  CLI arguments override config file settings.

  Example config:
    {
      "allowSshAgent": false,
      "allowGpgAgent": false,
      "allowXdgRuntime": false
    }

Security:
  By default, claudebox blocks access to /run/user/$UID (XDG runtime directory)
  which contains DBus, audio, display, and other sensitive sockets.
  Use --allow-* flags to selectively enable access to specific services.

Examples:
  claudebox                               # Run with default settings
  claudebox --allow-ssh-agent             # Allow SSH agent for git operations
  claudebox --allow-xdg-runtime           # Allow full XDG runtime access`);
}

// =============================================================================
// Main
// =============================================================================

function main() {
	const args = process.argv.slice(2);
	const options = parseArgs(args);

	// Session setup
	const projectDir = process.cwd();
	const repoRoot = getRepoRoot(projectDir);
	const sessionId = randomHex(8);

	// Create isolated home directory
	const home = process.env.HOME;
	const claudeHome = path.join(getTmpDir(), `claudebox-${sessionId}`);

	// Cleanup handler
	const cleanup = () => {
		try {
			fs.rmSync(claudeHome, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	};

	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(130);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(143);
	});

	fs.mkdirSync(claudeHome, { recursive: true });

	// Copy SSH public keys and known_hosts into sandbox home
	if (options.allowSshAgent) {
		const sshDir = path.join(home, ".ssh");
		if (isDirectory(sshDir)) {
			const sandboxSshDir = path.join(claudeHome, ".ssh");
			fs.mkdirSync(sandboxSshDir, { mode: 0o700 });
			fs.mkdirSync(path.join(sandboxSshDir, "controlmaster"), {
				mode: 0o700,
			});

			// Copy known_hosts
			const knownHosts = path.join(sshDir, "known_hosts");
			if (pathExists(knownHosts)) {
				fs.copyFileSync(knownHosts, path.join(sandboxSshDir, "known_hosts"));
			}

			// Copy config with IdentityAgent rewritten to sandbox socket path
			const configSrc = path.join(sshDir, "config");
			if (pathExists(configSrc)) {
				let configContent = fs.readFileSync(configSrc, "utf8");
				configContent = configContent.replace(
					/^(\s*IdentityAgent\s+).*$/gm,
					`$1${SANDBOX_SSH_SOCK}`,
				);
				fs.writeFileSync(path.join(sandboxSshDir, "config"), configContent, {
					mode: 0o600,
				});
			}

			try {
				for (const file of fs.readdirSync(sshDir)) {
					if (file.endsWith(".pub")) {
						fs.copyFileSync(
							path.join(sshDir, file),
							path.join(sandboxSshDir, file),
						);
					}
				}
			} catch {
				// Ignore errors reading .ssh directory
			}
		}
	}

	// Claude config directories
	const claudeConfig = path.join(home, ".claude");
	fs.mkdirSync(claudeConfig, { recursive: true });
	const claudeJson = path.join(home, ".claude.json");

	// Initialize Claude if needed
	if (!pathExists(claudeJson)) {
		console.log("Initializing Claude configuration...");
		try {
			execSync("claude --help", { stdio: "ignore" });
		} catch {
			// Ignore initialization errors
		}
	}

	// Smart filesystem sharing
	const realRepoRoot = realpath(repoRoot);
	const realHome = realpath(home);

	let shareTree;
	if (realRepoRoot.startsWith(realHome + "/")) {
		const relPath = realRepoRoot.slice(realHome.length + 1);
		const topDir = relPath.split("/")[0];
		shareTree = path.join(realHome, topDir);
	} else {
		shareTree = realRepoRoot;
	}

	// Create sandbox
	let sandbox;
	try {
		sandbox = Sandbox.create({
			claudeHome,
			claudeConfig,
			claudeJson,
			shareTree,
			repoRoot,
			allowSshAgent: options.allowSshAgent,
			allowGpgAgent: options.allowGpgAgent,
			allowXdgRuntime: options.allowXdgRuntime,
		});
	} catch (err) {
		console.error(`Error: ${err.message}`);
		process.exit(1);
	}

	// Build script and launch
	const script = `
cd '${projectDir}'
exec claude --dangerously-skip-permissions
`;

	if (options.dryRun) {
		sandbox.dryRun(script);
		cleanup();
		process.exit(0);
	}

	const child = sandbox.spawn(script);
	child.on("close", (code) => process.exit(code || 0));
}

main();
