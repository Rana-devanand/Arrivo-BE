# Keystash setup

This folder was created by the `keystash` npm package. It pushes your `.env` files to your Keystash project.
Only values that are new or changed are saved, so pushing again never re-sends everything.

## 1. Create an API key (once, by a project admin)

1. Open Keystash, pick the project, go to **Settings → API keys**.
2. Create a key and copy it. It is shown only once.
3. Paste it into `keystash/.env.keystash`:

```
KEYSTASH_API_KEY=ks_xxxxxxxxxxxxxxxx
```

This file is git-ignored. In CI, set `KEYSTASH_API_KEY` as a secret instead.

## 2. Push

```bash
npm run env:push          # pushes every env file listed in keystash/keystash.config.json
npm run env:check         # shows which project your key belongs to
npx keystash push .env.production --env production    # one specific file
npx keystash push --dry-run                           # show what would be sent
npx keystash push --all                               # ignore local memory and re-check everything
```

`keystash/keystash.config.json` decides which file goes to which environment:

```json
{
  "api": "https://key-stash-be.vercel.app/api",
  "files": { ".env": "development", ".env.production": "production" }
}
```

## 3. Scripts in package.json

The installer adds these for you if they were missing:

```json
"scripts": {
  "env:push": "keystash push",
  "env:check": "keystash check"
}
```

To push automatically before a deploy, call it from another script, for example
`"predeploy": "npm run env:push"`.

## Good to know

- The key only works for one project, and can only add or update values (never read or delete).
- Never commit `.env` files or `keystash/.env.keystash`.
- If the key stops working, ask an admin to create a new one (Settings → API keys).
