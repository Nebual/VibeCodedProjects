// Production entrypoint. Nitro reads the port from the environment at runtime
// and there's no build-time setting for it, so the defaults are applied here —
// in the repo rather than a .env file that can go missing.
//
// `pnpm start` runs this with --env-file-if-exists=.env, so a local .env is
// already merged into process.env by the time this executes. These are `||=`
// fallbacks, so anything from .env or the shell wins over the defaults below.
process.env.NITRO_PORT ||= process.env.PORT || '8188'
// Bind on all interfaces so the port can be published out of a container.
process.env.NITRO_HOST ||= '0.0.0.0'

await import('../.output/server/index.mjs')
