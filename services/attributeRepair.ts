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

type Kind = 'length' | 'mass' | 'volume' | 'data' | 'power' | 'apparent' | 'voltage' | 'area';

// Factor from each unit to its kind's base unit (cm, g, mL, MB, W, VA, V,
// mm²). Keys cover both ML's unit ids ('"', 'cm', 'fl oz', …) and SP-API's
// unit names ('inches', 'kilograms', …), lowercased.
const UNIT_FACTORS: Record<Kind, Record<string, number>> = {
    length: {
        '"': 2.54, in: 2.54, inch: 2.54, inches: 2.54, cm: 1, centimeters: 1,
        mm: 0.1, millimeters: 0.1, m: 100, meters: 100, km: 100000, kilometers: 100000,
        ft: 30.48, feet: 30.48,
    },
    mass: {
        g: 1, grams: 1, kg: 1000, kilograms: 1000, mg: 0.001, milligrams: 0.001, mcg: 0.000001,
        lb: 453.59237, pounds: 453.59237, oz: 28.349523125, ounces: 28.349523125, t: 1000000, ct: 0.2,
    },
    power: { w: 1, watts: 1, kw: 1000, kilowatts: 1000 },
    apparent: { va: 1, kva: 1000 },
    voltage: { v: 1, volts: 1, kv: 1000, mv: 0.001 },
    area: { 'mm²': 1, mm2: 1, 'cm²': 100, cm2: 100, 'm²': 1000000, m2: 1000000 },
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
    PRODUCT_WEIGHT: ['item_weight'], UNIT_WEIGHT: ['item_weight'], BAR_WEIGHT: ['item_weight'],
    NET_WEIGHT: ['item_net_weight'],
};
const VOLUME_KEYS = ['capacity', 'liquid_volume', 'item_volume'];
const DATA_KEYS = ['memory_storage_capacity', 'capacity'];
// The device's own power in watts — not RMS or peak figures, which titles
// rarely state as such ("1200w" on a subwoofer is its peak).
const POWER_IDS = new Set(['POWER', 'POWER_OUTPUT', 'OUTPUT_POWER', 'WATTAGE', 'RATED_POWER']);
const POWER_KEYS = ['wattage', 'output_wattage'];
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
    PIECES_NUMBER: ['number_of_pieces'], NUMBER_OF_PIECES: ['number_of_pieces'],
};
// Counts written in the title, e.g. "Juego De Cubiertos 20 Piezas", "Escalera 7 Escalones".
const PIECES_IN_TEXT = /(\d+)\s*(piezas|pzas|pzs|pcs|pz)\b/;
const COUNT_IN_TEXT: Record<string, RegExp> = {
    PIECES_NUMBER: PIECES_IN_TEXT, NUMBER_OF_PIECES: PIECES_IN_TEXT, PIECES_QUANTITY: PIECES_IN_TEXT,
    STEPS_NUMBER: /(\d+)\s*(escalones|peldanos)\b/,
};

// A volume written in the title, e.g. "Botella 560 Ml", "Termo 1.2 Litros", "32 oz".
const VOLUME_IN_TEXT = /(\d+(?:[.,]\d+)?)\s*(ml|mililitros?|cc|lts?|litros?|l|fl\.?\s?oz|oz|onzas?|galones|galon|gal)\b/;
const VOLUME_TOKENS: Record<string, string> = {
    ml: 'ml', mililitro: 'ml', mililitros: 'ml', cc: 'cc', l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l',
    oz: 'fl oz', onza: 'fl oz', onzas: 'fl oz', gal: 'gal', galon: 'gal', galones: 'gal',
};
// A storage size in the title, e.g. "Memoria Micro Sd 128gb".
const DATA_IN_TEXT = /(\d+(?:[.,]\d+)?)\s*(tb|gb|mb|kb)\b/;
// Other measurements as titles write them (already lowercased, no accents):
// "Pedal 9v", "Fuente 850w", "Ups 1500va", "Alimento Seco 2kg", "Monitor 32
// Pulgadas", "Cable 16 Awg". Each maps the written unit to a UNIT_FACTORS key.
const MEASURE_IN_TEXT: Partial<Record<Kind, { re: RegExp; unit: (written: string) => string }>> = {
    voltage: { re: /(\d+(?:[.,]\d+)?)\s*(kv|voltios|volts?|v)\b/, unit: w => (w === 'kv' ? 'kv' : 'v') },
    power: { re: /(\d+(?:[.,]\d+)?)\s*(kw|watts?|w)\b/, unit: w => (w === 'kw' ? 'kw' : 'w') },
    apparent: { re: /(\d+(?:[.,]\d+)?)\s*(kva|va)\b/, unit: w => w },
    mass: {
        re: /(\d+(?:[.,]\d+)?)\s*(kilogramos?|kilos?|kgs?|gramos?|grs?|g|libras?|lbs?|onzas?|oz)\b/,
        unit: w => (w.startsWith('k') ? 'kg' : w.startsWith('g') ? 'g' : w.startsWith('l') ? 'lb' : 'oz'),
    },
};
const INCHES_IN_TEXT = /(\d+(?:[.,]\d+)?)\s*(pulgadas?|pulg|in\b|"|'')/;
const AWG_IN_TEXT = /(\d+)\s*awg\b/;
// "Paquete 50", "Pack De 3", "3 Paquetes" — how many units one sale holds.
const PACK_COUNT_IN_TEXT = [/(?:paquete|pack|caja)\s*(?:de|con)?\s*(\d+)\b/, /(\d+)\s*(?:pack|paquetes|unidades)\b/];

export interface RepairContext {
    title: string;
    categoryAttributes: any[];                        // GET /categories/{id}/attributes
    amazonAttributes?: Record<string, any[]> | null;  // SP-API catalog item attributes
}

export interface RepairResult {
    attributes: any[];
    changed: boolean;
    filled: string[];        // e.g. "Altura: 36 cm (Amazon)"
    dropped: string[];       // optional attributes removed because ML rejected their value
    open: { name: string; ids: string[] }[]; // what's still missing, each with the attributes it takes
    unresolved: string[];    // required attributes still without a value, by name
    unresolvedIds: string[]; // the same, by attribute id (for the seller to fill in by hand)
}

export interface CauseAnalysis {
    missing: Set<string>;
    invalid: Set<string>;
    packageDimensions: boolean;
    productCode: boolean;
    titleGender: boolean;  // 4210: the title names a different gender than GENDER
    saleUnits: boolean;    // 3709: SALE_FORMAT and the units per pack disagree
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

// A one-word value with its other gender and number endings — titles say
// "Alimento Seco" where the category's value is "Seca", "Negra" for "Negro".
function wordForms(name: string): string[] {
    if (/\s/.test(name)) return [name];
    const base = name.replace(/s$/, '');
    const swapped = /a$/.test(base) ? base.slice(0, -1) + 'o' : /o$/.test(base) ? base.slice(0, -1) + 'a' : base;
    return [...new Set([name, base, base + 's', swapped, swapped + 's'])];
}

// The first allowed value whose name appears in the text as a whole word —
// the longest one when several do. Names under 3 characters ("Sí", "No")
// are never matched this way. GENDER only matches exactly: there the ending
// is the meaning ("Niños" and "Niñas" are different values).
function matchAllowedValue(def: any, texts: string[]): any | null {
    const haystacks = texts.filter(Boolean).map(normalize);
    const forms = def?.id === 'GENDER' ? (name: string) => [name] : wordForms;
    let best: any = null;
    for (const v of def?.values ?? []) {
        const name = normalize(String(v?.name ?? ''));
        if (name.length < 3) continue;
        const found = forms(name).some(form => {
            const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(form)}([^a-z0-9]|$)`);
            return haystacks.some(h => re.test(h));
        });
        if (found && (!best || name.length > normalize(best.name).length)) best = v;
    }
    return best;
}

// A measurement of the given kind written in the text, as { value, unit key }.
function measureFromText(kind: Kind, text: string): { value: number; unit: string } | null {
    const spec = MEASURE_IN_TEXT[kind];
    const m = spec && normalize(text).match(spec.re);
    const value = m ? Number(m[1].replace(',', '.')) : NaN;
    return m && value > 0 ? { value, unit: spec!.unit(m[2]) } : null;
}

// Every value an SP-API attribute holds, joined (power_source_type can list several).
const amazonAllText = (attrs: Record<string, any[]> | null | undefined, key: string): string =>
    (Array.isArray(attrs?.[key]) ? attrs![key] : []).map((e: any) => e?.value).filter((v: any) => typeof v === 'string').join(' ');

// American wire gauge to cross-section: d = 0.127 mm × 92^((36 − n) / 39).
const awgToMm2 = (n: number): number => Math.PI / 4 * (0.127 * Math.pow(92, (36 - n) / 39)) ** 2;

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
        if (kind === 'length' && /DISPLAY_SIZE|SCREEN_SIZE/.test(id)) {
            const m = normalize(ctx.title).match(INCHES_IN_TEXT);
            const titleValue = m && toAllowedUnit(def, kind, Number(m[1].replace(',', '.')), 'in');
            if (titleValue) return { value: { value_name: titleValue }, source: 'título' };
            for (const key of ['display_size', 'screen_size']) {
                const am = asMeasure(amazonEntry(amazon, key));
                const formatted = am && toAllowedUnit(def, kind, am.value, am.unit);
                if (formatted) return { value: { value_name: formatted }, source: 'Amazon' };
            }
        }
        // Net content is what the pack, and so the title, states ("Alimento 2kg").
        // Only for NET_WEIGHT: other weights in a title are often a load
        // capacity ("Escalera 170 Kg").
        if (kind === 'mass' && id === 'NET_WEIGHT') {
            const t = measureFromText('mass', ctx.title);
            const titleValue = t && toAllowedUnit(def, kind, t.value, t.unit);
            if (titleValue) return { value: { value_name: titleValue }, source: 'título' };
        }
        if ((kind === 'power' && POWER_IDS.has(id)) || kind === 'apparent' || (kind === 'voltage' && /VOLTAGE/.test(id))) {
            const t = measureFromText(kind, ctx.title);
            const titleValue = t && toAllowedUnit(def, kind, t.value, t.unit);
            if (titleValue) return { value: { value_name: titleValue }, source: 'título' };
            for (const key of kind === 'power' ? POWER_KEYS : kind === 'voltage' ? ['voltage'] : []) {
                const am = asMeasure(amazonEntry(amazon, key));
                const formatted = am && toAllowedUnit(def, kind, am.value, am.unit);
                if (formatted) return { value: { value_name: formatted }, source: 'Amazon' };
            }
        }
        if (kind === 'area' && id === 'SECTION_SIZE') {
            const awg = normalize(ctx.title).match(AWG_IN_TEXT);
            const titleValue = awg && toAllowedUnit(def, kind, awgToMm2(Number(awg[1])), 'mm²');
            if (titleValue) return { value: { value_name: titleValue }, source: `título (${awg![1]} AWG)` };
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
            // Amazon's size is often the volume as text ("750 ml", "0.6 Litros").
            const sized = volumeFromText(amazonText(amazon, ['size']) ?? '');
            const sizedValue = sized && toAllowedUnit(def, kind, sized.value, sized.unit);
            if (sizedValue) return { value: { value_name: sizedValue }, source: 'Amazon' };
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
        const inTitle = COUNT_IN_TEXT[id] && normalize(ctx.title).match(COUNT_IN_TEXT[id]);
        if (inTitle && Number(inTitle[1]) > 0) return { value: { value_name: String(Number(inTitle[1])) }, source: 'título' };
        const text = COUNT_SOURCES[id] ? amazonText(amazon, COUNT_SOURCES[id]) : null;
        const n = text ? Number(text) : NaN;
        return Number.isFinite(n) && n > 0 ? { value: { value_name: String(Math.round(n)) }, source: 'Amazon' } : null;
    }

    // "Con USB": yes when the title or Amazon says USB; no when Amazon names
    // a power source that isn't one. Otherwise there's nothing to go on.
    if (id === 'WITH_USB' && valueType === 'boolean') {
        const option = (re: RegExp) => def.values?.find((v: any) => re.test(normalize(String(v?.name ?? ''))));
        const power = amazonAllText(amazon, 'power_source_type');
        const said = [ctx.title, power, amazonAllText(amazon, 'connectivity_technology')].join(' ');
        const pick = /\busb\b/i.test(said) ? option(/^si$/) : power ? option(/^no$/) : null;
        return pick ? { value: { value_id: pick.id, value_name: pick.name }, source: /\busb\b/i.test(ctx.title) ? 'título' : 'Amazon' } : null;
    }

    // A voltage asked for as text ("Voltaje": "9 V").
    if (/VOLTAGE/.test(id) && valueType === 'string') {
        const t = measureFromText('voltage', ctx.title) ?? asMeasure(amazonEntry(amazon, 'voltage'));
        const factor = t && UNIT_FACTORS.voltage[t.unit.toLowerCase()];
        if (t && factor) return { value: { value_name: `${formatNumber(t.value * factor)} V` }, source: measureFromText('voltage', ctx.title) ? 'título' : 'Amazon' };
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
    const analysis: CauseAnalysis = {
        missing: new Set(), invalid: new Set(), packageDimensions: false, productCode: false, titleGender: false, saleUnits: false,
    };
    for (const c of causes ?? []) {
        if (c?.type && c.type !== 'error') continue;
        const code = String(c?.code ?? '');
        const message = String(c?.message ?? '');
        const ids = attributeIdsIn(message, idByName);
        if (MISSING_CODES.has(code)) ids.forEach(id => analysis.missing.add(id));
        else if (code === 'invalid.title.gender') analysis.titleGender = true;
        else if (code === 'item.attribute.invalid_sale_units' || /formato de venta/i.test(message)) analysis.saleUnits = true;
        else if (INVALID_CODES.has(code)) ids.forEach(id => analysis.invalid.add(id));
        else if (PACKAGE_CODE.test(code)) analysis.packageDimensions = true;
        else if (PRODUCT_CODE_CODE.test(code)) analysis.productCode = true;
    }
    return analysis;
}

export const hasRepairableCauses = (causes: any[] | undefined): boolean => {
    const a = analyzeCauses(causes);
    return a.missing.size > 0 || a.invalid.size > 0 || a.packageDimensions || a.productCode || a.titleGender || a.saleUnits;
};

// Problems no attribute value can solve, said plainly for the seller.
export function explainUnfixable(causes: any[] | undefined): string[] {
    const out: string[] = [];
    for (const c of causes ?? []) {
        if (c?.type && c.type !== 'error') continue;
        if (/fashion_grid/.test(String(c?.code ?? ''))) {
            out.push('Ropa y calzado: Mercado Libre pide una guía de tallas, que se crea en Mercado Libre (no se puede llenar desde aquí)');
        }
    }
    return [...new Set(out)];
}

export function repairAttributes(attributes: any[] | undefined, causes: any[] | undefined, ctx: RepairContext): RepairResult {
    const defs = new Map<string, any>((Array.isArray(ctx.categoryAttributes) ? ctx.categoryAttributes : []).map((d: any) => [d.id, d]));
    const label = (id: string) => defs.get(id)?.name ?? id;
    const attrs = new Map<string, any>((attributes ?? []).filter(a => a?.id).map(a => [a.id, a]));
    const { missing, invalid, packageDimensions: needsPackage, productCode, titleGender, saleUnits } = analyzeCauses(causes, ctx.categoryAttributes);
    const filled: string[] = [];
    const dropped: string[] = [];
    const open: { name: string; ids: string[] }[] = [];
    const leaveOpen = (name: string, ...ids: string[]) => { open.push({ name, ids }); };

    const set = (id: string, value: { value_id?: string; value_name: string }, source: string) => {
        attrs.set(id, { id, ...value });
        filled.push(`${label(id)}: ${value.value_name} (${source})`);
    };

    // The title is what the buyer reads, so GENDER follows it ("Gorra … Hombre").
    if (titleGender) {
        const match = matchAllowedValue(defs.get('GENDER'), [ctx.title]);
        if (match && attrs.get('GENDER')?.value_name !== match.name) set('GENDER', { value_id: match.id, value_name: match.name }, 'título');
        else leaveOpen('Género (no coincide con el título)', 'GENDER');
    }

    // "Pack" needs more than one unit ("Ingresa un valor diferente a 1 porque
    // completaste Pack"). Confirmed live on kits and sets sold as one piece, so
    // unless the title says how many come in the pack, it is one unit.
    if (saleUnits) {
        const format = defs.get('SALE_FORMAT');
        const unitsId = ['UNITS_PER_PACK', 'UNITS_PER_PACKAGE'].find(id => attrs.has(id) || defs.has(id)) ?? 'UNITS_PER_PACK';
        const option = (re: RegExp) => format?.values?.find((v: any) => re.test(normalize(String(v?.name ?? ''))));
        const counted = PACK_COUNT_IN_TEXT.map(re => normalize(ctx.title).match(re)).find(Boolean);
        const count = counted ? Number(counted[1]) : 0;
        const pack = option(/^pack$/), unit = option(/^unidad$/);
        if (count > 1 && pack) {
            set('SALE_FORMAT', { value_id: pack.id, value_name: pack.name }, 'título');
            set(unitsId, { value_name: String(count) }, 'título');
        } else if (unit) {
            set('SALE_FORMAT', { value_id: unit.id, value_name: unit.name }, 'se vende como una pieza');
            set(unitsId, { value_name: '1' }, 'se vende como una pieza');
        } else {
            leaveOpen(label('SALE_FORMAT'), 'SALE_FORMAT', unitsId);
        }
    }

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
        else leaveOpen(label(id), id);
    }

    if (needsPackage) {
        const fromAmazon = packageDimensions(ctx.amazonAttributes);
        const pkg = fromAmazon ?? roundedPackageDimensions(attrs);
        if (pkg) for (const id of PACKAGE_ATTRS) set(id, { value_name: pkg[id] }, fromAmazon ? 'Amazon' : 'redondeado');
        else leaveOpen('Medidas y peso del paquete', ...PACKAGE_ATTRS);
    }

    return {
        attributes: Array.from(attrs.values()),
        changed: filled.length > 0 || dropped.length > 0,
        filled, dropped, open,
        unresolved: open.map(o => o.name),
        unresolvedIds: open.flatMap(o => o.ids),
    };
}

// What the AI is never asked for: barcodes (only the real one will do), the
// package's measures (Amazon's, the saved ones rounded, or the seller's) and
// size charts (made on Mercado Libre).
export const aiMayFill = (id: string): boolean =>
    !CODE_ATTRS.includes(id) && !PACKAGE_ATTRS.includes(id) && id !== 'EMPTY_GTIN_REASON' && !/^SIZE_GRID/.test(id);

// The product as the AI reads it: Amazon's bullet points, then its other
// catalog attributes one line each (Amazon México's entry, without the
// marketplace and language tags).
export function amazonSummary(attrs: Record<string, any[]> | null | undefined, limit = 3500): string {
    if (!attrs) return '';
    const bullets = (Array.isArray(attrs.bullet_point) ? attrs.bullet_point : [])
        .filter((e: any) => !e?.marketplace_id || e.marketplace_id === 'A1AM78C64UM0Y8')
        .map((e: any) => e?.value)
        .filter((v: any) => typeof v === 'string' && v.trim());
    const rest = Object.keys(attrs)
        .filter(key => key !== 'bullet_point')
        .map(key => {
            const entry = amazonEntry(attrs, key);
            if (!entry || typeof entry !== 'object') return null;
            const { marketplace_id, language_tag, ...value } = entry;
            return `${key}: ${JSON.stringify(value).slice(0, 200)}`;
        })
        .filter(Boolean);
    return [
        bullets.length ? `Datos de Amazon:\n- ${bullets.join('\n- ')}` : '',
        rest.length ? `Atributos de Amazon: ${rest.join('; ')}` : '',
    ].filter(Boolean).join('\n').slice(0, limit);
}

// One AI answer (see ai-importer's fillAttributes) in the shape ML takes for
// the attribute, or null: one of the category's own values, a number in one
// of its units, a number, or text that isn't the attribute's own name (the
// filler ML rejects). Nothing else is ever used.
export function aiAttributeValue(def: any, proposed: any): { value_id?: string; value_name: string } | null {
    if (!def || !proposed || typeof proposed !== 'object') return null;
    const values: any[] = Array.isArray(def.values) ? def.values : [];
    const valueType: string = def.value_type ?? '';
    if (valueType === 'list' || valueType === 'boolean') {
        const id = proposed.value_id != null ? String(proposed.value_id) : null;
        const name = normalize(String(proposed.value_name ?? proposed.text ?? ''));
        const match = values.find(v => (id && String(v.id) === id) || (name && normalize(String(v.name ?? '')) === name));
        return match ? { value_id: String(match.id), value_name: String(match.name) } : null;
    }
    // Ages start at 0 ("0 meses"); a size or weight of 0 is rejected.
    const n = Number(String(proposed.number ?? '').replace(',', '.'));
    const valid = Number.isFinite(n) && (n > 0 || (n === 0 && /AGE/.test(String(def.id))));
    if (valueType === 'number_unit') {
        const unit = (def.allowed_units ?? []).find((u: any) =>
            [u.id, u.name].some(x => x != null && String(x) === String(proposed.unit ?? '')));
        return unit && valid ? { value_name: `${formatNumber(n)} ${unit.name ?? unit.id}` } : null;
    }
    if (valueType === 'number') return valid ? { value_name: formatNumber(n) } : null;
    const text = String(proposed.text ?? proposed.value_name ?? '').trim();
    if (!text || normalize(text) === normalize(String(def.name ?? ''))) return null;
    const suggested = values.find(v => normalize(String(v.name ?? '')) === normalize(text));
    return suggested ? { value_id: String(suggested.id), value_name: String(suggested.name) } : { value_name: text.slice(0, 255) };
}

// Attributes whose value is a fact only the product's own data can give: a
// norm or certification, a model, part or kit number, a year, a character or
// collection, what it's compatible with. Confirmed live that the AI still
// wrote a safety norm ("ECE R44/04") for a child booster seat whose Amazon
// data names none, so for these its answer is used only if that data has it.
const FACT_TOKENS = new Set(['REGULATIONS', 'REGULATION', 'CERTIFICATIONS', 'CERTIFICATION', 'NORMS', 'STANDARD', 'STANDARDS', 'MODEL', 'YEAR', 'CHARACTER', 'COLLECTION', 'COMPATIBLE']);
const isFactAttribute = (id: string): boolean =>
    /(^|_)(PART|KIT)_NUMBER$/.test(id) || id.split('_').some(token => FACT_TOKENS.has(token));

// The AI's answers applied to what repairAttributes left open: each checked
// first (aiAttributeValue, and for facts, against the product data the AI
// read), and an open item closed once all its attributes have a value.
export function applyAiValues(repair: RepairResult, answers: Record<string, any>, categoryAttributes: any[], productData: string): RepairResult {
    const defs = new Map<string, any>((Array.isArray(categoryAttributes) ? categoryAttributes : []).map((d: any) => [d.id, d]));
    const attrs = new Map<string, any>(repair.attributes.filter(a => a?.id).map(a => [a.id, a]));
    const data = normalize(productData);
    const filled = [...repair.filled];
    const answered = new Set<string>();
    for (const id of repair.unresolvedIds) {
        const value = aiAttributeValue(defs.get(id), answers?.[id]);
        if (!value) continue;
        if (isFactAttribute(id) && !data.includes(normalize(value.value_name))) continue;
        attrs.set(id, { id, ...value });
        filled.push(`${defs.get(id)?.name ?? id}: ${value.value_name} (IA)`);
        answered.add(id);
    }
    if (answered.size === 0) return repair;
    const open = repair.open
        .map(o => ({ ...o, ids: o.ids.filter(id => !answered.has(id)) }))
        .filter(o => o.ids.length > 0);
    return {
        ...repair,
        attributes: Array.from(attrs.values()),
        changed: true,
        filled, open,
        unresolved: open.map(o => o.name),
        unresolvedIds: open.flatMap(o => o.ids),
    };
}

// What the seller's form needs to ask for an attribute: its name, its type
// and, depending on it, the allowed units or the category's own values.
export function attributeFormDef(def: any, id: string) {
    return {
        id,
        name: def?.name ?? id,
        value_type: def?.value_type ?? 'string',
        ...(Array.isArray(def?.allowed_units) && def.allowed_units.length
            ? { allowed_units: def.allowed_units.map((u: any) => ({ id: u.id ?? u.name, name: u.name ?? u.id })), default_unit: def.default_unit ?? null }
            : {}),
        ...(Array.isArray(def?.values) && def.values.length
            ? { values: def.values.slice(0, 300).map((v: any) => ({ id: v.id, name: v.name })) }
            : {}),
    };
}

// Attributes whose value is just the attribute's own name ("Color: Color",
// "Número de parte: Número de parte") — filler the transferred listings
// brought along; Mercado Libre's own generated titles even appended it
// ("… Color Nombre Del Diseño"). Optional ones are simply left out; required
// ones can't be, or ML rejects the listing (see replacePlaceholders).
export function fillerAttributeIds(attributes: any[] | undefined, categoryAttributes: any[]): { required: string[]; optional: string[] } {
    const defs = new Map<string, any>((Array.isArray(categoryAttributes) ? categoryAttributes : []).map((d: any) => [d.id, d]));
    const out = { required: [] as string[], optional: [] as string[] };
    for (const a of attributes ?? []) {
        const def = defs.get(a?.id);
        if (!def || !a.value_name || normalize(String(a.value_name)) !== normalize(String(def.name ?? ''))) continue;
        (isRequired(def) ? out.required : out.optional).push(a.id);
    }
    return out;
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
    return { attributes: Array.from(attrs.values()), changed: filled.length > 0, filled, dropped: [], open: [], unresolved: [], unresolvedIds: [] };
}

// A title (or family_name) cut after the last whole word that fits, with no
// connector or punctuation left dangling — the same rule as ml_fit_title in
// the database.
export function fitToWords(text: string, limit: number): string {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (clean.length <= limit) return clean;
    let cut = clean.slice(0, limit + 1).replace(/\s+\S*$/, '');
    if (cut.length > limit) cut = cut.slice(0, limit);
    return cut
        .replace(/(\s+(de|del|con|para|por|en|sin|y|la|las|el|los|al|que))+$/i, '')
        .replace(/[\s,;:/+&-]+$/, '');
}

// The listing's ASIN: Melidrop stores it as the seller SKU.
export function asinOf(payload: any): string | null {
    const sku = payload?.attributes?.find((a: any) => a?.id === 'SELLER_SKU')?.value_name ?? payload?.seller_custom_field;
    const asin = String(sku ?? '').trim().toUpperCase();
    return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
}
