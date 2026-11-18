export function normalizeServiceTier(value) {
  if (value == null) {
    return null;
  }
  const tier = String(value).trim().toLowerCase();
  if (tier !== "fast" && tier !== "default") {
    throw new Error(`Unsupported service tier "${value}". Use fast or default.`);
  }
  return tier;
}

export function resolveServiceTier(options) {
  const tier = normalizeServiceTier(options["service-tier"]);
  if (options.fast === false) {
    throw new Error("Use --service-tier default to select standard speed.");
  }
  if (options.fast && tier && tier !== "fast") {
    throw new Error("Choose either --fast or --service-tier default.");
  }
  return options.fast ? "fast" : tier;
}

export function displayServiceTier(tier) {
  if (tier === "priority") {
    return "fast";
  }
  return tier ?? null;
}
