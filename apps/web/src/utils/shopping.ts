import { roughlyInChina, roughlyInUS, type MealSpot, type ShoppingItem } from '@app/shared';
import { splitEnglish } from './text';

/**
 * 健康计划里"要买的东西"在哪买（设计文档 §9.13）：
 * - 排计划时告诉「健康」附近有哪些超市（Google 地图搜的）、你那里能用哪些网店（onlineShopsText），
 *   它写的"在哪买"只用这些名字；
 * - 显示时：认得出的网店、连锁超市在它自己的网站上搜（美国：Amazon、Kroger 家的店、Walmart、Target、Costco；
 *   国内：京东、淘宝；别的国家用当地的 Amazon），附近的超市能点开 Google 地图，认不出的用 Google 搜"店名 + 商品"。
 */

interface Shop {
  id: string;
  name: string;
  /** 认这个名字（连同它家的其他招牌） */
  match: RegExp;
  /** 在它的网站上搜 */
  search: (q: string) => string;
}

/** 各国的 Amazon */
const AMAZON_DOMAIN: Record<string, string> = {
  US: 'amazon.com',
  CA: 'amazon.ca',
  MX: 'amazon.com.mx',
  BR: 'amazon.com.br',
  GB: 'amazon.co.uk',
  DE: 'amazon.de',
  FR: 'amazon.fr',
  IT: 'amazon.it',
  ES: 'amazon.es',
  NL: 'amazon.nl',
  BE: 'amazon.com.be',
  SE: 'amazon.se',
  PL: 'amazon.pl',
  TR: 'amazon.com.tr',
  JP: 'amazon.co.jp',
  IN: 'amazon.in',
  SG: 'amazon.sg',
  AU: 'amazon.com.au',
  AE: 'amazon.ae',
  SA: 'amazon.sa',
  EG: 'amazon.eg',
};

/** Kroger 和它家的招牌（kroger.com 能配送、到店自提的那些） */
const KROGER =
  /kroger|ralphs|fred\s*meyer|king\s*soopers|harris\s*teeter|smith'?s\s+food|fry'?s\s+(?:food|marketplace)|\bqfc\b|mariano'?s|dillons|food\s*4\s*less|foods\s*co\b|pick\s*'?n\s*save|metro\s*market|city\s*market/i;
const TARGET = /\btarget\b/i;
const COSTCO = /costco|好市多|开市客/i;

function shopsFor(country: string | undefined): Shop[] {
  const q = encodeURIComponent;
  const out: Shop[] = [];
  const amazon = country ? AMAZON_DOMAIN[country] : undefined;
  if (amazon) out.push({ id: 'amazon', name: 'Amazon', match: /amazon|亚马逊/i, search: (s) => `https://www.${amazon}/s?k=${q(s)}` });
  if (country === 'US') {
    out.push(
      { id: 'kroger', name: 'Kroger', match: KROGER, search: (s) => `https://www.kroger.com/search?query=${q(s)}` },
      { id: 'walmart', name: 'Walmart', match: /walmart|沃尔玛/i, search: (s) => `https://www.walmart.com/search?q=${q(s)}` },
      { id: 'target', name: 'Target', match: TARGET, search: (s) => `https://www.target.com/s?searchTerm=${q(s)}` },
      { id: 'costco', name: 'Costco', match: COSTCO, search: (s) => `https://www.costco.com/CatalogSearch?keyword=${q(s)}` },
    );
  }
  if (country === 'CN') {
    out.push(
      { id: 'jd', name: '京东', match: /京东|jd\.com/i, search: (s) => `https://search.jd.com/Search?keyword=${q(s)}` },
      { id: 'taobao', name: '淘宝', match: /淘宝|天猫|taobao|tmall/i, search: (s) => `https://s.taobao.com/search?q=${q(s)}` },
    );
  }
  return out;
}

/** 你在哪个国家（ISO 代码）：地理编码给的优先，没有就按经纬度粗算美国、中国 */
export function countryAt(code: string | undefined | null, at: { lat: number; lng: number } | null | undefined): string | undefined {
  if (code) return code.toUpperCase();
  if (!at) return undefined;
  if (roughlyInUS(at.lat, at.lng)) return 'US';
  if (roughlyInChina(at.lat, at.lng)) return 'CN';
  return undefined;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 两个店名说的是不是同一家（"Sweetgreen" 和 "sweetgreen Midtown"、"Trader Joe's" 和 "Trader Joes"） */
export function samePlaceName(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && long.includes(short);
}

/** 排计划时给「健康」的一行：你那里能用哪些网店（美国按附近有没有 Kroger、Target、Costco 的店来写） */
export function onlineShopsText(country: string | undefined, nearbyStores: { name: string }[]): string {
  if (country === 'US') {
    const near = (re: RegExp) => nearbyStores.find((s) => re.test(s.name));
    const kroger = near(KROGER);
    return [
      'Amazon（amazon.com：Amazon Fresh / Whole Foods 配送生鲜；干货、调料、蛋白粉这类耐放的东西第二天到）',
      'Walmart（walmart.com 配送或到店自提）',
      kroger ? `Kroger（kroger.com 配送或到店自提；附近的 ${kroger.name} 就是 Kroger 家的）` : 'Kroger（kroger.com；附近没搜到 Kroger 家的店，可能不送你这里，少写）',
      near(TARGET) ? 'Target（target.com 配送或到店自提）' : '',
      near(COSTCO) ? 'Costco（要会员，包装大）' : '',
      'Instacart（从附近的超市代买，当天送上门）',
    ]
      .filter(Boolean)
      .join('；');
  }
  if (country === 'CN') return '京东（京东超市、京东到家）；淘宝 / 天猫超市；盒马；美团（小象超市）；叮咚买菜';
  const amazon = country ? AMAZON_DOMAIN[country] : undefined;
  return amazon ? `Amazon（${amazon}）` : '';
}

/** "在哪买"写的是附近搜到的哪家超市（点开地图、看多远） */
export function nearbyStoreFor(where: string, stores: MealSpot[] | undefined): MealSpot | undefined {
  const w = where.trim();
  if (!w || !stores?.length) return undefined;
  return stores.find((s) => samePlaceName(s.name, w));
}

/**
 * 去哪搜这一样：认得出的网店、连锁超市在它网站上搜；认不出、但写了店名的用 Google 搜；
 * 没写在哪买、写了搜什么（或者名字里带英文原名）的在当地 Amazon 搜；都没写的（以前存的一行文字）不给链接
 */
export function searchLinkFor(item: ShoppingItem, country: string | undefined): { label: string; url: string } | null {
  const where = item.where.trim();
  // 没写搜什么时用名字里括号写的英文原名
  const en = splitEnglish(item.name).en;
  const q = (item.search || en || item.name).trim();
  if (!q || (!where && !item.search.trim() && !en)) return null;
  const shops = shopsFor(country);
  const shop = where ? shops.find((s) => s.match.test(where)) : shops.find((s) => s.id === 'amazon');
  if (shop) return { label: `在 ${shop.name} 搜`, url: shop.search(q) };
  if (where) return { label: '搜一下', url: `https://www.google.com/search?q=${encodeURIComponent(`${where} ${q}`)}` };
  return null;
}

/** 一段话里提到了附近的哪家店（备案里"去 CAVA 点……"）：名字最长的那家优先 */
export function placeMentioned<T extends { name: string }>(text: string | undefined, places: T[]): T | undefined {
  const t = norm(text ?? '');
  if (!t) return undefined;
  return [...places].sort((a, b) => b.name.length - a.name.length).find((p) => {
    const n = norm(p.name);
    return n.length >= 3 && t.includes(n);
  });
}
