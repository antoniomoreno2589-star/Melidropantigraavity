// Completes what Mercado Libre's publish validation reports as missing or
// invalid in a listing's attributes, from real data only: the category's own
// attribute definitions, the listing's title and the Amazon product.
//
// Confirmed live with /items/validate on 125 of the listings transferred to a
// new account: 14% were rejected, mostly for required attributes with no value
// (HEIGHT/DEPTH, SPORT_BOTTLE_CAPACITY, VOLUME_CAPACITY, TOTAL_WEIGHT, MODEL,
// PART_NUMBER) or values outside the category's list (BASE_TYPE "Tipo de base",
// PRODUCT_TYPE "Adaptador"). Marking a required attribute "no aplica"
// (value_id -1, as ML's docs describe for attributes that don't apply) is not
// a way out: ML answers "HEIGHT is a required attribute for channel marketplace
// and cannot be not applicable". So nothing is guessed — whatever has no real
// source is returned in `unresolved`, by name, for the seller to fill in.
//
// ML references: developers.mercadolibre.com.mx/es_ar/atributos (types, tags,
// N/A, package dimensions) and /es_ar/validaciones (error codes).

type Kind = 'length' | 'mass' | 'volume' | 'data';

// Factor from each unit to its kind's base unit (cm, g, mL, MB). Keys cover both
// ML's unit ids ('"', 'cm', 'fl oz', …) and SP-API's unit names ('inches',
// 'kilograms', …), lowercased.
const UNIT_FACTORS: Record<Kind, Record<string, number>> = {
    length: {
        '"': 2.54, in: 2.54, inch: 2.54, inches: 2.54, cm: 1, centimeters: 1,
        mm: 0.1, millimeters: 0.1, m: 100, meters: 100, km: 100000, kilometers: 100000,
        ft: 30.48, feet: 30.48,
    },
    mass: {
        g: 1, grams: 1, kg: 1000, kilograms: 1000, mg: 0.001, milligrams: 0.001,
        lb: 453.59237, pounds: 453.59237, oz: 28.349523125, ounces: 28.349523125,
    },
    volume: {
        ml: 1, milliliters: 1, cc: 1, 'cm³': 1, cubic_centimeters: 1, l: 1000, liters: 1000,
        // A capacity in "ounces" is fluid ounces; weight ounces only ever
        // come up for mass attributes, which use the table above.
        'fl oz': 29.5735295625, fluid_ounces: 29.5735295625, oz: 29.5735295625, ounces: 29.5735295625,
        gal: 3785.411784, gallons: 3785.411784, cups: 236.5882365, quarts: 946.352946, pints: 473.176473,
    },
    // Storage, in the decimal units products are sold by (a "128 GB" card).
    data: {
        kb: 0.001, kilobytes: 0.001, mb: 1, megabytes: 1, gb: 1000, gigabytes: 1000, tb: 1000000, terabytes: 1000000,
    },
};

const MISSING_CODES = new Set([
    'item.attributes.missing_required',           // 147
    'item.attribute.missing_conditional_required', // 7810
    'item.attribute.missing_catalog_required',     // 3704
]);
const INVALID_CODES = new Set([
    'invalid.item.attribute.values',               // 3510
    'item.attribute.number_invalid_format',        // 3708
    'item.attributes.invalid_length',              // 154
    'item.attribute.values.name.invalid',          // 394
]);
// 5400 missing / 5401 absurd / 5402 wrong format — the four SELLER_PACKAGE_*
// attributes, mandatory for ME2 cross docking and xd_drop_off sellers even
// though no category marks them required.
const PACKAGE_CODE = /seller\.package\.dimensions/;
// 7710/7711/7712/7714, 3701, 3711, 3712: a universal code ML won't accept here.
const PRODUCT_CODE_CODE = /product_identifier|gtin|universal_code/i;

const PACKAGE_ATTRS = ['SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_WEIGHT'];
const CODE_ATTRS = ['GTIN', 'EAN', 'UPC', 'ITEM_BARCODE', 'UNIVERSAL_CODE'];

// The listing's own measurement attributes and the SP-API fields that hold
// the same measurement. Only exact counterparts: DEPTH is not read from
// Amazon's "length", which is depth for some products and width for others.
const DIMENSION_SOURCES: Record<string, 'height' | 'width' | 'length' | 'depth'> = {
    HEIGHT: 'height', WIDTH: 'width', LENGTH: 'length', DEPTH: 'depth',
};
const DIMENSION_KEYS = ['item_depth_width_height', 'item_length_width_height', 'item_dimensions', 'item_width_height'];
const WEIGHT_SOURCES: Record<string, string[]> = {
    WEIGHT: ['item_weight'], TOTAL_WEIGHT: ['item_weight'], ITEM_WEIGHT: ['item_weight'],
    PRODUCT_WEIGHT: ['item_weight'], UNIT_WEIGHT: ['item_weight'], NET_WEIGHT: ['item_net_weight'],
};
const VOLUME_KEYS = ['capacity', 'liquid_volume', 'item_volume'];
const DATA_KEYS = ['memory_storage_capacity', 'capacity'];
const TEXT_SOURCES: Record<string, string[]> = {
    MODEL: ['model_number', 'model_name', 'part_number'],
    ALPHANUMERIC_MODEL: ['model_number', 'part_number'],
    PART_NUMBER: ['part_number', 'model_number'],
    MPN: ['part_number', 'model_number'],
    BRAND: ['brand'],
    MANUFACTURER: ['manufacturer'],
};
const COUNT_SOURCES: Record<string, string[]> = {
    UNITS_PER_PACK: ['number_of_items', 'item_package_quantity'],
    UNITS_PER_PACKAGE: ['number_of_items', 'item_package_quantity'],
};

// A volume written in the title, e.g. "Botella 560 Ml", "Termo 1.2 Litros", "32 oz".
const VOLUME_IN_TEXT = /(\d+(?:[.,]\d+)?)\s*(ml|mililitros?|cc|lts?|litros?|l|fl\.?\s?oz|oz|onzas?|galones|galon|gal)\b/;
const VOLUME_TOKENS: Record<string, string> = {
    ml: 'ml', mililitro: 'ml', mililitros: 'ml', cc: 'cc', l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l',
    oz: 'fl oz', onza: 'fl oz', onzas: 'fl oz', gal: 'gal', galon: 'gal', galones: 'gal',
};
// A storage size in the title, e.g. "Memoria Micro Sd 128gb".
const DATA_IN_TEXT = /(\d+(?:[.,]\d+)?)\s*(tb|gb|mb|kb)\b/;

export interface RepairContext {
    title: string;
    categoryAttributes: any[];                        // GET /categories/{id}/attributes
    amazonAttributes?: Record<string, any[]> | null;  // SP-API catalog item attributes
}

export interface RepairResult {
    attributes: any[];
    changed: boolean;
    filled: string[];      // e.g. "Altura: 36 cm (Amazon)"
    dropped: string[];     // optional attributes removed because ML rejected their value
    unresolved: string[];  // required attributes still without a value, by name
}

export interface CauseAnalysis {
    missing: Set<string>;
    invalid: Set<string>;
    packageDimensions: boolean;
    productCode: boolean;
}

const normalize = (s: string): string =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isRequired = (def: any): boolean => !!(def?.tags?.required || def?.tags?.new_required);

const formatNumber = (n: number): string => {
    const digits = n >= 100 ? 0 : n >= 10 ? 1 : 2;
    return String(Number(n.toFixed(digits)));
};

// The attribute's kind of measurement, from its allowed units ('oz' alone is
// ambiguous, so it doesn't count).
function measureKind(def: any): Kind | null {
    const counts = Object.fromEntries(Object.keys(UNIT_FACTORS).map(k => [k, 0])) as Record<Kind, number>;
    for (const u of def?.allowed_units ?? []) {
        const id = String(u.id ?? u.name ?? '').toLowerCase();
        if (id === 'oz') continue;
        for (const kind of Object.keys(UNIT_FACTORS) as Kind[]) {
            if (id in UNIT_FACTORS[kind]) counts[kind]++;
        }
    }
    const best = (Object.keys(counts) as Kind[]).sort((a, b) => counts[b] - counts[a])[0];
    return counts[best] > 0 ? best : null;
}

// A value converted into one of the attribute's own allowed units, formatted
// the way ML expects number_unit values ("36 cm", "591 mL").
function toAllowedUnit(def: any, kind: Kind, value: number, fromUnit: string): string | null {
    const fromFactor = UNIT_FACTORS[kind][fromUnit.toLowerCase()];
    if (!fromFactor || !(value > 0)) return null;
    const units: any[] = def?.allowed_units ?? [];
    const sameKind = units.filter(u => UNIT_FACTORS[kind][String(u.id ?? u.name).toLowerCase()]);
    const target = sameKind.find(u => u.id === def.default_unit) ?? sameKind[0];
    if (!target) return null;
    const targetFactor = UNIT_FACTORS[kind][String(target.id ?? target.name).toLowerCase()];
    return `${formatNumber(value * fromFactor / targetFactor)} ${target.name ?? target.id}`;
}

// SP-API attribute values are arrays of per-marketplace entries; prefer
// Amazon México's.
function amazonEntry(attrs: Record<string, any[]> | null | undefined, key: string): any | null {
    const list = attrs?.[key];
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.find(e => !e?.marketplace_id || e.marketplace_id === 'A1AM78C64UM0Y8') ?? list[0];
}

function amazonText(attrs: Record<string, any[]> | null | undefined, keys: string[]): string | null {
    for (const key of keys) {
        const value = amazonEntry(attrs, key)?.value;
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number') return String(value);
    }
    return null;
}

const asMeasure = (m: any): { value: number; unit: string } | null =>
    m && typeof m.value === 'number' && typeof m.unit === 'string' ? { value: m.value, unit: m.unit } : null;

// The first allowed value whose name appears in the text as a whole word —
// the longest one when several do. Names under 3 characters ("Sí", "No")
// are never matched this way.
function matchAllowedValue(def: any, texts: string[]): any | null {
    const haystacks = texts.filter(Boolean).map(normalize);
    let best: any = null;
    for (const v of def?.values ?? []) {
        const name = normalize(String(v?.name ?? ''));
        if (name.length < 3) continue;
        const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(name)}([^a-z0-9]|$)`);
        if (haystacks.some(h => re.test(h)) && (!best || name.length > normalize(best.name).length)) best = v;
    }
    return best;
}

function volumeFromText(text: string): { value: number; unit: string } | null {
    const m = normalize(text).match(VOLUME_IN_TEXT);
    if (!m) return null;
    const unit = VOLUME_TOKENS[m[2].replace(/\s|\./g, '').replace(/^fl/, '')] ?? null;
    const value = Number(m[1].replace(',', '.'));
    return unit && value > 0 ? { value, unit } : null;
}

// What to fill a required attribute with, and where it came from — null when
// there's no real source for it.
export function inferAttributeValue(def: any, ctx: RepairContext): { value: { value_id?: string; value_name: string }; source: string } | null {
    const id: string = def?.id ?? '';
    const amazon = ctx.amazonAttributes;
    const valueType: string = def?.value_type ?? '';
    const hasValues = Array.isArray(def?.values) && def.values.length > 0;

    if (def?.tags?.fixed && hasValues && def.values.length === 1) {
        return { value: { value_id: def.values[0].id, value_name: def.values[0].name }, source: 'único valor de la categoría' };
    }

    if (valueType === 'number_unit') {
        const kind = measureKind(def);
        if (!kind) return null;
        if (kind === 'length' && DIMENSION_SOURCES[id]) {
            const side = DIMENSION_SOURCES[id];
            for (const key of DIMENSION_KEYS) {
                const m = asMeasure(amazonEntry(amazon, key)?.[side]);
                const formatted = m && toAllowedUnit(def, kind, m.value, m.unit);
                if (formatted) return { value: { value_name: formatted }, source: 'Amazon' };
            }
        }
        if (kind === 'mass' && WEIGHT_SOURCES[id]) {
            for (const key of WEIGHT_SOURCES[id]) {
                const m = asMeasure(amazonEntry(amazon, key));
                const formatted = m && toAllowedUnit(def, kind, m.value, m.unit);
                if (formatted) return { value: { value_name: formatted }, source: 'Amazon' };
            }
        }
        if (kind === 'volume' && /CAPACITY|VOLUME/.test(id)) {
            // The title first: it's what the buyer reads, and Amazon's catalog
            // can describe another size of the same product — confirmed live:
            // a listing titled "560 Ml" whose Amazon capacity was 24 fl oz.
            const fromTitle = volumeFromText(ctx.title);
            const titleValue = fromTitle && toAllowedUnit(def, kind, fromTitle.value, fromTitle.unit);
            if (titleValue) return { value: { value_name: titleValue }, source: 'título' };
            for (const key of VOLUME_KEYS) {
                const m = asMeasure(amazonEntry(amazon, key));
                const formatted = m && toAllowedUnit(def, kind, m.value, m.unit);
                if (formatted) return { value: { value_name: formatted }, source: 'Amazon' };
            }
        }
        if (kind === 'data' && /CAPACITY|MEMORY|STORAGE/.test(id)) {
            // Title first, for the same reason as volumes.
            const m = normalize(ctx.title).match(DATA_IN_TEXT);
            const titleValue = m && toAllowedUnit(def, kind, Number(m[1].replace(',', '.')), m[2]);
            if (titleValue) return { value: { value_name: titleValue }, source: 'título' };
            for (const key of DATA_KEYS) {
                const am = asMeasure(amazonEntry(amazon, key));
                const formatted = am && toAllowedUnit(def, kind, am.value, am.unit);
                if (formatted) return { value: { value_name: formatted }, source: 'Amazon' };
            }
        }
        return null;
    }

    if (valueType === 'number') {
        const text = COUNT_SOURCES[id] ? amazonText(amazon, COUNT_SOURCES[id]) : null;
        const n = text ? Number(text) : NaN;
        return Number.isFinite(n) && n > 0 ? { value: { value_name: String(Math.round(n)) }, source: 'Amazon' } : null;
    }

    // Closed lists (and booleans) only take one of the category's own values.
    if (valueType === 'list' || valueType === 'boolean') {
        const texts = [ctx.title];
        if (/MATERIAL/.test(id)) texts.push(amazonText(amazon, ['material']) ?? '');
        if (/COLOR/.test(id)) texts.push(amazonText(amazon, ['color']) ?? '');
        const match = matchAllowedValue(def, texts);
        return match ? { value: { value_id: match.id, value_name: match.name }, source: 'título' } : null;
    }

    // Free text (ML suggests values but accepts others).
    const sources = TEXT_SOURCES[id]
        ?? (/MATERIALS?$/.test(id) ? ['material'] : /(^|_)COLOR$/.test(id) ? ['color'] : null);
    const text = sources ? amazonText(amazon, sources) : null;
    if (text) return { value: { value_name: text.slice(0, 255) }, source: 'Amazon' };
    if (hasValues) {
        const match = matchAllowedValue(def, [ctx.title]);
        if (match) return { value: { value_id: match.id, value_name: match.name }, source: 'título' };
    }
    return null;
}

// "El producto no tiene código registrado" — the same option the importer
// picks when Amazon has no barcode (see seedEmptyGtinReason).
function emptyGtinReason(def: any): { value_id: string; value_name: string } | null {
    const option = def?.values?.find((v: any) => /no tiene c[oó]digo registrado/i.test(v?.name ?? ''));
    return option ? { value_id: option.id, value_name: option.name } : null;
}

function packageDimensions(amazon: Record<string, any[]> | null | undefined): Record<string, string> | null {
    const dims = amazonEntry(amazon, 'item_package_dimensions');
    const weight = asMeasure(amazonEntry(amazon, 'item_package_weight'));
    const cm = (side: string) => {
        const m = asMeasure(dims?.[side]);
        const factor = m && UNIT_FACTORS.length[m.unit.toLowerCase()];
        return m && factor ? Math.ceil(m.value * factor) : 0;
    };
    const grams = weight && UNIT_FACTORS.mass[weight.unit.toLowerCase()] ? Math.ceil(weight.value * UNIT_FACTORS.mass[weight.unit.toLowerCase()]) : 0;
    const height = cm('height'), length = cm('length'), width = cm('width');
    // Integers only, in cm and g (error 5402 otherwise); rounded up so the
    // declared package is never smaller than the real one.
    if (!(height > 0 && length > 0 && width > 0 && grams > 0)) return null;
    return {
        SELLER_PACKAGE_HEIGHT: `${height} cm`, SELLER_PACKAGE_LENGTH: `${length} cm`,
        SELLER_PACKAGE_WIDTH: `${width} cm`, SELLER_PACKAGE_WEIGHT: `${grams} g`,
    };
}

// The listing's own package attributes rounded up to whole cm and g (error
// 5402 is decimals) — used when Amazon has no package data to replace them.
function roundedPackageDimensions(attrs: Map<string, any>): Record<string, string> | null {
    const out: Record<string, string> = {};
    for (const id of PACKAGE_ATTRS) {
        const n = Number(String(attrs.get(id)?.value_name ?? '').match(/\d+(?:\.\d+)?/)?.[0]);
        if (!(n > 0)) return null;
        out[id] = `${Math.ceil(n)} ${id === 'SELLER_PACKAGE_WEIGHT' ? 'g' : 'cm'}`;
    }
    return out;
}

// Attribute ids a cause message refers to: "[HEIGHT, DEPTH]" style lists, or
// a quoted name ('El campo "Altura" es obligatorio') looked up in the category.
function attributeIdsIn(message: string, idByName: Map<string, string>): string[] {
    const ids: string[] = [];
    for (const m of message.matchAll(/\[([^\]]+)\]/g)) {
        for (const part of m[1].split(',')) {
            const id = part.trim();
            if (/^[A-Z0-9_]+$/.test(id)) ids.push(id);
        }
    }
    for (const m of message.matchAll(/["“]([^"”]+)["”]/g)) {
        const id = idByName.get(normalize(m[1]));
        if (id) ids.push(id);
    }
    return ids;
}

export function analyzeCauses(causes: any[] | undefined, categoryAttributes: any[] = []): CauseAnalysis {
    const defs = Array.isArray(categoryAttributes) ? categoryAttributes : [];
    const idByName = new Map(defs.map((d: any) => [normalize(String(d?.name ?? '')), d.id]));
    const analysis: CauseAnalysis = { missing: new Set(), invalid: new Set(), packageDimensions: false, productCode: false };
    for (const c of causes ?? []) {
        if (c?.type && c.type !== 'error') continue;
        const code = String(c?.code ?? '');
        const ids = attributeIdsIn(String(c?.message ?? ''), idByName);
        if (MISSING_CODES.has(code)) ids.forEach(id => analysis.missing.add(id));
        else if (INVALID_CODES.has(code)) ids.forEach(id => analysis.invalid.add(id));
        else if (PACKAGE_CODE.test(code)) analysis.packageDimensions = true;
        else if (PRODUCT_CODE_CODE.test(code)) analysis.productCode = true;
    }
    return analysis;
}

export const hasRepairableCauses = (causes: any[] | undefined): boolean => {
    const a = analyzeCauses(causes);
    return a.missing.size > 0 || a.invalid.size > 0 || a.packageDimensions || a.productCode;
};

export function repairAttributes(attributes: any[] | undefined, causes: any[] | undefined, ctx: RepairContext): RepairResult {
    const defs = new Map<string, any>((Array.isArray(ctx.categoryAttributes) ? ctx.categoryAttributes : []).map((d: any) => [d.id, d]));
    const label = (id: string) => defs.get(id)?.name ?? id;
    const attrs = new Map<string, any>((attributes ?? []).filter(a => a?.id).map(a => [a.id, a]));
    const { missing, invalid, packageDimensions: needsPackage, productCode } = analyzeCauses(causes, ctx.categoryAttributes);
    const filled: string[] = [];
    const dropped: string[] = [];
    const unresolved: string[] = [];

    const set = (id: string, value: { value_id?: string; value_name: string }, source: string) => {
        attrs.set(id, { id, ...value });
        filled.push(`${label(id)}: ${value.value_name} (${source})`);
    };

    if (productCode) {
        for (const id of CODE_ATTRS) if (attrs.delete(id)) dropped.push(label(id));
        const reason = emptyGtinReason(defs.get('EMPTY_GTIN_REASON'));
        if (reason) set('EMPTY_GTIN_REASON', reason, 'sin código universal');
    }

    // Values ML just rejected, so the same one isn't offered back to it.
    const rejected = new Map<string, string>();
    for (const id of invalid) {
        const reason = id === 'EMPTY_GTIN_REASON' ? emptyGtinReason(defs.get(id)) : null;
        if (reason) { set(id, reason, 'valor de la categoría'); continue; }
        // A required attribute still needs a value — look for a valid one
        // below; an optional one is better left out than rejected.
        if (isRequired(defs.get(id))) {
            rejected.set(id, normalize(String(attrs.get(id)?.value_name ?? '')));
            attrs.delete(id);
            missing.add(id);
            continue;
        }
        if (attrs.delete(id)) dropped.push(label(id));
    }

    for (const id of missing) {
        const def = defs.get(id);
        const inferred = def ? inferAttributeValue(def, ctx) : null;
        if (inferred && rejected.get(id) !== normalize(inferred.value.value_name)) set(id, inferred.value, inferred.source);
        else unresolved.push(label(id));
    }

    if (needsPackage) {
        const fromAmazon = packageDimensions(ctx.amazonAttributes);
        const pkg = fromAmazon ?? roundedPackageDimensions(attrs);
        if (pkg) for (const id of PACKAGE_ATTRS) set(id, { value_name: pkg[id] }, fromAmazon ? 'Amazon' : 'redondeado');
        else unresolved.push('Medidas y peso del paquete');
    }

    return {
        attributes: Array.from(attrs.values()),
        changed: filled.length > 0 || dropped.length > 0,
        filled, dropped, unresolved,
    };
}

// Required attributes whose value is just the attribute's own name ("Número de
// parte: Número de parte") — filler the transferred listings brought along;
// Mercado Libre's own generated titles even appended it ("… Color Nombre Del
// Diseño"). Optional ones were removed from the saved payloads outright;
// required ones can't be, or ML rejects the listing.
export function placeholderAttributeIds(attributes: any[] | undefined, categoryAttributes: any[]): string[] {
    const defs = new Map<string, any>((Array.isArray(categoryAttributes) ? categoryAttributes : []).map((d: any) => [d.id, d]));
    return (attributes ?? [])
        .filter(a => {
            const def = defs.get(a?.id);
            return def && isRequired(def) && a.value_name && normalize(String(a.value_name)) === normalize(String(def.name ?? ''));
        })
        .map(a => a.id);
}

// Those placeholders replaced with the real value where the title or Amazon
// has one; the rest are left as they are (still publishable).
export function replacePlaceholders(attributes: any[] | undefined, ids: string[], ctx: RepairContext): RepairResult {
    const defs = new Map<string, any>((Array.isArray(ctx.categoryAttributes) ? ctx.categoryAttributes : []).map((d: any) => [d.id, d]));
    const attrs = new Map<string, any>((attributes ?? []).filter(a => a?.id).map(a => [a.id, a]));
    const filled: string[] = [];
    for (const id of ids) {
        const def = defs.get(id);
        const inferred = def ? inferAttributeValue(def, ctx) : null;
        if (!inferred) continue;
        attrs.set(id, { id, ...inferred.value });
        filled.push(`${def.name ?? id}: ${inferred.value.value_name} (${inferred.source}, en lugar de "${def.name ?? id}")`);
    }
    return { attributes: Array.from(attrs.values()), changed: filled.length > 0, filled, dropped: [], unresolved: [] };
}

// The listing's ASIN: Melidrop stores it as the seller SKU.
export function asinOf(payload: any): string | null {
    const sku = payload?.attributes?.find((a: any) => a?.id === 'SELLER_SKU')?.value_name ?? payload?.seller_custom_field;
    const asin = String(sku ?? '').trim().toUpperCase();
    return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
}
