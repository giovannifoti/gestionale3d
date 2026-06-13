import type { Customer, Order, PriceBreakdown, PricingInputs, PrintMetrics, QuoteItem } from "../types";
import { DEFAULT_PRICING, PRINTER_PROFILE, calculatePrice, formatCurrency, formatNumber, getMaterial } from "./pricing";

type QuoteLinePayload = {
  item: QuoteItem;
  breakdown: PriceBreakdown;
};

type QuotePayload = {
  quoteNumber: string;
  customer: Customer;
  customerNumber: string;
  metrics: PrintMetrics;
  pricing: PricingInputs;
  breakdown: PriceBreakdown;
  items?: QuoteLinePayload[];
  notes: string;
};

export function openQuote(payload: QuotePayload): void {
  const popup = window.open("", "_blank", "width=900,height=1100");
  if (!popup) {
    return;
  }

  popup.document.write(buildQuoteHtml(payload));
  popup.document.close();
  popup.focus();
  window.setTimeout(() => popup.print(), 400);
}

export function openOrderQuote(order: Order): void {
  const popup = window.open("", "_blank", "width=900,height=1100");
  if (!popup) {
    return;
  }

  popup.document.write(buildSavedOrderHtml(order));
  popup.document.close();
  popup.focus();
  window.setTimeout(() => popup.print(), 400);
}

function buildQuoteHtml(payload: QuotePayload): string {
  const material = getMaterial(payload.pricing.materialKey);
  const date = new Date().toLocaleDateString("it-IT");
  const customerName = escapeHtml(payload.customer.name || "Cliente");
  const notes = escapeHtml(payload.notes || "Validita preventivo: 15 giorni. File e parametri da confermare prima della stampa.");
  const hasItems = Boolean(payload.items?.length);

  return quoteShell({
    title: `Preventivo ${payload.quoteNumber}`,
    body: `
      <header>
        <div>
          <p class="eyebrow">Preventivo stampa 3D</p>
          <h1>${payload.quoteNumber}</h1>
        </div>
        <div class="right">
          <strong>${date}</strong>
          <span>Gestionale personale</span>
        </div>
      </header>
      <section class="grid">
        <div>
          <h2>Cliente</h2>
          <p>${customerName}</p>
          <p>Numero cliente: ${escapeHtml(payload.customerNumber || "-")}</p>
          <p>${escapeHtml(payload.customer.email)}</p>
          <p>${escapeHtml(payload.customer.phone)}</p>
        </div>
        <div>
          <h2>File</h2>
          <p>${hasItems ? `${payload.items?.length ?? 0} prodotti caricati` : escapeHtml(payload.metrics.fileName)}</p>
          <p>${escapeHtml(payload.metrics.kind.toUpperCase())}</p>
        </div>
      </section>
      <table>
        <thead>
          <tr>
            <th>Voce</th>
            <th>Dettagli</th>
            <th class="num">Totale</th>
          </tr>
        </thead>
        <tbody>
          ${
            payload.items?.length
              ? buildQuoteItemRows(payload.items, material.name, payload.pricing)
              : buildSingleQuoteRow(payload.metrics.fileName, payload.pricing, payload.breakdown, material.name)
          }
          ${
            payload.pricing.includeVat
              ? `<tr><td>IVA</td><td>${payload.pricing.vatPercent}%</td><td class="num">${formatCurrency(payload.breakdown.vatAmount)}</td></tr>`
              : ""
          }
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2">Totale preventivo</td>
            <td class="num">${formatCurrency(payload.breakdown.grossPrice)}</td>
          </tr>
        </tfoot>
      </table>
      <section>
        <h2>Note</h2>
        <p>${notes}</p>
      </section>
    `,
  });
}

function buildSavedOrderHtml(order: Order): string {
  const hasItems = Boolean(order.items?.length);
  return quoteShell({
    title: `Preventivo ${order.quoteNumber}`,
    body: `
      <header>
        <div>
          <p class="eyebrow">Preventivo stampa 3D</p>
          <h1>${escapeHtml(order.quoteNumber)}</h1>
        </div>
        <div class="right">
          <strong>${new Date(order.createdAt).toLocaleDateString("it-IT")}</strong>
          <span>${escapeHtml(order.status)}</span>
        </div>
      </header>
      <section class="grid">
        <div>
          <h2>Cliente</h2>
          <p>${escapeHtml(order.customer.name || "Cliente")}</p>
          <p>Numero cliente: ${escapeHtml(order.customerNumber || order.customer.phone || "-")}</p>
          <p>${escapeHtml(order.customer.email)}</p>
          <p>${escapeHtml(order.customer.phone)}</p>
        </div>
        <div>
          <h2>File</h2>
          <p>${hasItems ? `${order.items?.length ?? 0} prodotti caricati` : escapeHtml(order.fileName)}</p>
          <p>${escapeHtml(order.metrics.kind.toUpperCase())}</p>
        </div>
      </section>
      <table>
        <thead>
          <tr>
            <th>Voce</th>
            <th>Dettagli</th>
            <th class="num">Totale</th>
          </tr>
        </thead>
        <tbody>
          ${order.items?.length ? buildSavedOrderItemRows(order) : buildSavedOrderSingleRow(order)}
          ${
            order.includeVat
              ? `<tr><td>IVA</td><td>${order.vatPercent ?? 22}%</td><td class="num">${formatCurrency(order.grossPrice - order.netPrice)}</td></tr>`
              : ""
          }
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2">Totale preventivo</td>
            <td class="num">${formatCurrency(order.grossPrice)}</td>
          </tr>
        </tfoot>
      </table>
      <section>
        <h2>Note</h2>
        <p>${escapeHtml(order.notes)}</p>
      </section>
    `,
  });
}

function buildQuoteItemRows(items: QuoteLinePayload[], materialName: string, pricing: PricingInputs): string {
  return items
    .map(
      ({ item, breakdown }) => `
        <tr>
          <td>${escapeHtml(item.name)}</td>
          <td>${item.quantity} pz, ${materialName}, ${escapeHtml(pricing.color)}, ${escapeHtml(pricing.finish)}, ${PRINTER_PROFILE.name}, ${formatNumber(item.manualMinutes / 60, 2)} h cad., ${formatNumber(item.filamentGrams)} g cad., ${formatNumber(pricing.powerKw, 2)} kW medi</td>
          <td class="num">${formatCurrency(breakdown.netPrice)}</td>
        </tr>
      `,
    )
    .join("");
}

function buildSingleQuoteRow(fileName: string, pricing: PricingInputs, breakdown: PriceBreakdown, materialName: string): string {
  return `
    <tr>
      <td>${escapeHtml(fileName || "Stampa 3D")}</td>
      <td>${pricing.quantity} pz, ${materialName}, ${escapeHtml(pricing.color)}, ${escapeHtml(pricing.finish)}, ${PRINTER_PROFILE.name}, ${formatNumber(pricing.manualMinutes / 60, 2)} h, ${formatNumber(pricing.filamentGrams)} g, ${formatNumber(pricing.powerKw, 2)} kW medi, guadagno ${formatNumber(pricing.marginPercent, 0)}%</td>
      <td class="num">${formatCurrency(breakdown.netPrice)}</td>
    </tr>
  `;
}

function buildSavedOrderItemRows(order: Order): string {
  const pricing = savedOrderPricing(order);
  return (order.items ?? [])
    .map((item) => {
      const lineBreakdown = calculatePrice({
        ...pricing,
        quantity: item.quantity,
        manualMinutes: item.manualMinutes,
        filamentGrams: item.filamentGrams,
        includeVat: false,
      });
      return `
        <tr>
          <td>${escapeHtml(item.name)}</td>
          <td>${item.quantity} pz, ${getMaterial(order.materialKey).name}, ${escapeHtml(order.color || "Bianco")}, ${escapeHtml(order.finish || "Standard")}, ${PRINTER_PROFILE.name}, ${formatNumber(item.manualMinutes / 60, 2)} h cad., ${formatNumber(item.filamentGrams)} g cad.</td>
          <td class="num">${formatCurrency(lineBreakdown.netPrice)}</td>
        </tr>
      `;
    })
    .join("");
}

function buildSavedOrderSingleRow(order: Order): string {
  return `
    <tr>
      <td>${escapeHtml(order.fileName || "Stampa 3D")}</td>
      <td>${order.quantity} pz, ${getMaterial(order.materialKey).name}, ${escapeHtml(order.color || "Bianco")}, ${escapeHtml(order.finish || "Standard")}, ${PRINTER_PROFILE.name}, ${formatNumber(order.averagePowerKw ?? PRINTER_PROFILE.defaultAveragePowerKw, 2)} kW medi, guadagno ${formatNumber(order.marginPercent ?? 125, 0)}%</td>
      <td class="num">${formatCurrency(order.netPrice)}</td>
    </tr>
  `;
}

function savedOrderPricing(order: Order): PricingInputs {
  return {
    ...DEFAULT_PRICING,
    materialKey: order.materialKey,
    quantity: order.quantity,
    manualMinutes: order.metrics.printTimeMinutes ?? DEFAULT_PRICING.manualMinutes,
    filamentGrams: order.metrics.filamentGrams ?? DEFAULT_PRICING.filamentGrams,
    machineRate: order.machineRate ?? PRINTER_PROFILE.machineRate,
    powerKw: order.averagePowerKw ?? PRINTER_PROFILE.defaultAveragePowerKw,
    energyCostKwh: order.energyCostKwh ?? PRINTER_PROFILE.energyCostKwh,
    marginPercent: order.marginPercent ?? 125,
    vatPercent: order.vatPercent ?? DEFAULT_PRICING.vatPercent,
    includeVat: Boolean(order.includeVat),
    color: order.color || "Bianco",
    finish: order.finish || "Standard",
  };
}

function quoteShell({ title, body }: { title: string; body: string }): string {
  return `
    <!doctype html>
    <html lang="it">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          @page { margin: 18mm; }
          * { box-sizing: border-box; }
          body { color: #1f2522; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; }
          header { align-items: flex-start; border-bottom: 2px solid #1f2522; display: flex; justify-content: space-between; margin-bottom: 32px; padding-bottom: 22px; }
          h1 { font-size: 34px; line-height: 1; margin: 6px 0 0; }
          h2 { font-size: 13px; letter-spacing: .08em; margin: 0 0 10px; text-transform: uppercase; }
          p { margin: 4px 0; }
          .eyebrow { color: #087f6a; font-size: 13px; font-weight: 800; letter-spacing: .08em; margin: 0; text-transform: uppercase; }
          .right { color: #59635e; display: grid; gap: 5px; justify-items: end; }
          .grid { display: grid; gap: 24px; grid-template-columns: 1fr 1fr; margin-bottom: 28px; }
          section { margin-bottom: 28px; }
          table { border-collapse: collapse; width: 100%; }
          th { background: #edf4f1; color: #4d5a54; font-size: 12px; letter-spacing: .06em; text-align: left; text-transform: uppercase; }
          th, td { border-bottom: 1px solid #d6ddd8; padding: 14px 12px; vertical-align: top; }
          tfoot td { border-bottom: 0; font-size: 18px; font-weight: 800; }
          .num { text-align: right; white-space: nowrap; }
        </style>
      </head>
      <body>${body}</body>
    </html>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
