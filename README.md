# <img alt="claudebox - responsible Claude Code YOLO" src="https://banner.numtide.com/banner/numtide/claudebox.svg">

Open your Claude Code project in a lightweight sandbox, and avoid unwanted surprises.

**Platforms:** Linux (stable), macOS (experimental)

The project shadows your $HOME, so no credentials are accessible (except
~/.claude).
The project parent folder is mounted read-only so it's possible to access
other dependencies.

## Recommended usage

This project is best used with [numtide/llm-agents.nix](https://github.com/numtide/llm-agents.nix) to get fresh Claude Code versions (among others).

## Installation

### Using Nix Flakes

```bash
nix run github:numtide/claudebox
```

Or add to your flake inputs:

```nix
{
  inputs.claudebox.url = "github:numtide/claudebox";
}
```

## Usage

```bash
claudebox [OPTIONS]
```

### Options

- `--allow-ssh-agent` - Allow access to SSH agent socket (for git operations)
- `--allow-gpg-agent` - Allow access to GPG agent socket (for signing)
- `--allow-xdg-runtime` - Allow full XDG runtime directory access
- `-h, --help` - Show help message

### Examples

```bash
# Run with default settings
claudebox

# Allow SSH agent for git operations
claudebox --allow-ssh-agent
```

## Configuration

Settings can be stored in `~/.config/claudebox/config.json` (or `$XDG_CONFIG_HOME/claudebox/config.json`).
CLI arguments override config file settings.

### Config Schema

```json
{
  "allowSshAgent": false,
  "allowGpgAgent": false,
  "allowXdgRuntime": false
}
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowSshAgent` | boolean | `false` | Mount SSH agent socket |
| `allowGpgAgent` | boolean | `false` | Mount GPG agent socket |
| `allowXdgRuntime` | boolean | `false` | Mount full XDG runtime dir |

## What it does

- Lightweight sandbox using bubblewrap (Linux) or sandbox-exec (macOS)
- Disables telemetry and auto-updates
- Uses `--dangerously-skip-permissions` (safe in sandbox)

## Security

### XDG Runtime Directory Isolation

By default, claudebox blocks access to `/run/user/$UID` (the XDG runtime directory).
This directory contains security-sensitive sockets:

| Path | Risk |
|------|------|
| `bus` | DBus session - can control other applications |
| `gnupg/` | GPG agent - can sign/encrypt with user's keys |
| `keyring/` | GNOME Keyring - SSH keys, secrets |
| `pipewire-*` | Audio/video capture and playback |
| `wayland-*` | Display access |
| `systemd/` | User systemd session control |

Use the `--allow-*` flags to selectively enable access when needed:

```bash
# Allow SSH agent for git push/pull with SSH keys
claudebox --allow-ssh-agent

# Allow GPG agent for commit signing
claudebox --allow-gpg-agent

# Allow full XDG runtime access (use with caution)
claudebox --allow-xdg-runtime
```

### Note

Not a security boundary - designed for transparency, not isolation.

## License

MIT
