# Cache Keeper

A Claude Code mod that adds a strip above the prompt box showing:

- A countdown until the prompt cache goes cold (detects the real 5-minute or 1-hour window; defaults to 60 minutes)
- Current context size in tokens
- Your 5-hour and weekly usage limits
- What the session would have cost on API billing
- What your next message would cost if the cache expired (and if it's still warm)
- A **Handoff & Clear** button: writes a handoff brief, runs `/clear`, and pastes the brief into the fresh session

It also notifies you 5 minutes before the cache goes cold.

## Install

At the prompt of a terminal session:

```
/plugin install cache-keeper --marketplace fgonzales11/cache-keeper
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install cache-keeper --marketplace fgonzales11/cache-keeper
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `fgonzales11/cache-keeper`, then Add plugin.

## Commands

- `/cache-window <minutes>` sets the cache window manually; `/cache-window auto` goes back to detection
- `/handoff` does the same as the button
- `/handoff-restore` pastes the last handoff brief again

Settings in `/config`: default window, warning lead time, and an input-price override ($ per million tokens).
