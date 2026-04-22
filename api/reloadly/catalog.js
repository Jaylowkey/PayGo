import { setCors, json, reloadlyGet } from './_shared.js';

function normalizeProduct(product) {
  const recipientCurrencyCode = product.recipientCurrencyCode || product.currencyCode || product.currency || 'USD';
  const price = Number(product.fixedRecipientDenominations?.[0] || product.fixedSenderDenominations?.[0] || product.minSenderDenomination || product.minRecipientDenomination || 0);
  return {
    id: `rl-${product.productId || product.id}`,
    type: 'giftcard',
    provider: 'reloadly',
    name: product.productName || product.name || 'Gift Card',
    brand: product.brand?.brandName || product.brandName || 'Reloadly',
    description: product.redeemInstruction?.concat ? product.redeemInstruction : 'Gift card digital via Reloadly.',
    usd: price,
    fixed: Boolean(product.fixedRecipientDenominations?.length || product.fixedSenderDenominations?.length),
    fixedDenominations: product.fixedRecipientDenominations || product.fixedSenderDenominations || [],
    minPrice: Number(product.minSenderDenomination || product.minRecipientDenomination || price || 0),
    maxPrice: Number(product.maxSenderDenomination || product.maxRecipientDenomination || price || 0),
    recipientCurrency: recipientCurrencyCode,
    recipientCountryCode: product.country?.isoName || product.countryCode || 'US',
    icon: 'gift',
    accent: 'warning',
    reloadlyProductId: product.productId || product.id,
    logo: product.logoUrls?.[0] || product.logoUrl || ''
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Método não permitido.' });

  try {
    const countryCode = String(req.query.countryCode || 'US').toUpperCase();
    const products = await reloadlyGet(`/countries/${countryCode}/products`, {
      size: req.query.size || 50,
      page: req.query.page || 1,
      recipientCurrencyCode: req.query.recipientCurrencyCode || 'USD'
    });

    const list = Array.isArray(products.content) ? products.content : Array.isArray(products) ? products : [];
    return json(res, 200, { success: true, products: list.map(normalizeProduct) });
  } catch (error) {
    return json(res, 500, { success: false, error: error.message || 'Falha ao carregar catálogo Reloadly.' });
  }
}
