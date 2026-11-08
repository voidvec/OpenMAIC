/**
 * The brand this deployment serves, read from the operator's configuration.
 *
 * `openmaic.yml` is the deployment's single settings file, so its `brand` block
 * is the primary source; the `OPENMAIC_BRAND_*` variables are the fallback (and
 * the only source under `pnpm dev`, where no file is mounted).
 *
 * Read once and cached, like the rest of the deployment layer: branding is not
 * per-request, and changing it means restarting the process — the same trade
 * the file's model configuration already makes.
 */
import { resolveBrand, type BrandConfig, type BrandFileBlock } from '@/lib/brand/brand-config';
import { loadModelConfigFile } from '@/lib/server/model-config/openmaic-yml';

let cached: BrandConfig | undefined;

function readBrandBlock(): BrandFileBlock | null {
  try {
    return loadModelConfigFile()?.brand ?? null;
  } catch {
    // An invalid file already stops the server at boot; a page that renders
    // before that check must still work, so the shipped brand stands in.
    return null;
  }
}

/** The resolved brand for this deployment. */
export function getBrand(): BrandConfig {
  cached ??= resolveBrand(process.env, readBrandBlock());
  return cached;
}

/** Drop the cached brand: for tests that change the environment in place. */
export function resetBrandCache(): void {
  cached = undefined;
}
