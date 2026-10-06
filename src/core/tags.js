// Keep this usable in the native core, which has no Intl implementation.
const tagKey = value => value.replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();

export function validateTags(input = []) {
  if (!Array.isArray(input) || input.length > 8)
    throw new Error('En fazla 8 etiket ekleyebilirsin.');
  const seen = new Set();
  return input.map(value => {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f,]/.test(value))
      throw new Error('Etiketler tek satır olmalı ve virgül içermemeli.');
    const tag = value.normalize('NFC').trim().replace(/ +/g, ' ');
    if (!tag || [...tag].length > 24) throw new Error('Her etiket 1–24 karakter olmalı.');
    return tag;
  }).filter(tag => {
    const key = tagKey(tag);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
