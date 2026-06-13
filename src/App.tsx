import { ChangeEvent, DragEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Calculator,
  Clock3,
  FileArchive,
  FileText,
  History,
  Lock,
  Package,
  Palette,
  PlusCircle,
  Printer,
  ReceiptText,
  Save,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Weight,
} from "lucide-react";
import { parsePrintFile } from "./lib/fileParsers";
import {
  DEFAULT_PRICING,
  PRINTER_PROFILE,
  SURCHARGES,
  calculatePrice,
  formatCurrency,
  formatNumber,
  getMaterial,
  suggestPricingFromMetrics,
} from "./lib/pricing";
import { openOrderQuote, openQuote } from "./lib/quote";
import { loadOrders, loadProducts, makeOrderId, makeQuoteNumber, saveOrders, saveProducts } from "./lib/storage";
import type {
  Customer,
  FrequentProduct,
  Order,
  OrderStatus,
  ParsedFile,
  PriceBreakdown,
  PricingInputs,
  PrintMetrics,
  QuoteItem,
} from "./types";

type ViewKey = "nuovo" | "storico" | "prodotti";

const STATUSES: OrderStatus[] = ["Bozza", "Preventivo inviato", "Accettato", "In stampa", "Completato"];

const EMPTY_CUSTOMER: Customer = {
  name: "",
  email: "",
  phone: "",
};

const EMPTY_PRODUCT: Omit<FrequentProduct, "id"> = {
  name: "",
  sku: "",
  defaultMinutes: 60,
  defaultGrams: 25,
  defaultQuantity: 1,
  color: "Bianco",
  finish: "Standard",
  notes: "",
};

function App() {
  const [view, setView] = useState<ViewKey>("nuovo");
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [quoteItems, setQuoteItems] = useState<QuoteItem[]>([]);
  const [itemName, setItemName] = useState("Stampa personalizzata");
  const [pricing, setPricing] = useState<PricingInputs>(DEFAULT_PRICING);
  const [customer, setCustomer] = useState<Customer>(EMPTY_CUSTOMER);
  const [customerNumber, setCustomerNumber] = useState("");
  const [notes, setNotes] = useState("Validita preventivo: 15 giorni. Bianco e nero inclusi nel prezzo base.");
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<FrequentProduct[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [productDraft, setProductDraft] = useState(EMPTY_PRODUCT);
  const [productSource, setProductSource] = useState<ParsedFile | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isParsingProduct, setIsParsingProduct] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [productDragActive, setProductDragActive] = useState(false);
  const [activeStatus, setActiveStatus] = useState<OrderStatus | "Tutti">("Tutti");
  const demoLoaded = useRef(false);

  useEffect(() => {
    setOrders(loadOrders());
    setProducts(loadProducts());
  }, []);

  useEffect(() => {
    if (demoLoaded.current || new URLSearchParams(window.location.search).get("demo") !== "gcode") {
      return;
    }
    demoLoaded.current = true;
    const demoFile = new File([DEMO_GCODE], "demo-portachiavi.gcode", { type: "text/plain" });
    void handleFile(demoFile);
  }, []);

  useEffect(() => {
    saveOrders(orders);
  }, [orders]);

  useEffect(() => {
    saveProducts(products);
  }, [products]);

  const pricedQuote = useMemo(() => {
    const rows = quoteItems.map((item) => {
      const automaticBreakdown = calculatePrice({
        ...pricing,
        quantity: item.quantity,
        manualMinutes: item.manualMinutes,
        filamentGrams: item.filamentGrams,
        color: item.color ?? pricing.color,
        finish: item.finish ?? pricing.finish,
      });
      return {
        item,
        breakdown: applyManualPriceToBreakdown(automaticBreakdown, item.manualPrice, item.quantity, pricing),
      };
    });
    return {
      rows,
      breakdown: rows.length ? combinePriceBreakdowns(rows.map((row) => row.breakdown)) : calculatePrice(pricing),
    };
  }, [pricing, quoteItems]);
  const breakdown = pricedQuote.breakdown;
  const quoteTotals = useMemo(
    () => ({
      files: quoteItems.length,
      quantity: quoteItems.reduce((total, item) => total + item.quantity, 0),
      minutes: quoteItems.reduce((total, item) => total + item.manualMinutes * item.quantity, 0),
      grams: quoteItems.reduce((total, item) => total + item.filamentGrams * item.quantity, 0),
    }),
    [quoteItems],
  );
  const selectedMaterial = getMaterial("pla");
  const filteredOrders = activeStatus === "Tutti" ? orders : orders.filter((order) => order.status === activeStatus);
  const selectedProducts = products.filter((product) => selectedProductIds.includes(product.id));
  const quoteWarnings = quoteItems.length
    ? quoteItems.flatMap((item) => item.metrics.warnings.map((warning) => `${item.name}: ${warning}`))
    : (parsed?.metrics.warnings ?? []);
  const quoteMetrics = quoteItems.length
    ? makeQuoteMetrics(itemName, quoteItems)
    : parsed
    ? {
        ...parsed.metrics,
        fileName: itemName || parsed.metrics.fileName,
        printTimeMinutes: pricing.manualMinutes,
        filamentGrams: pricing.filamentGrams,
      }
    : makeManualMetrics(itemName, pricing);

  async function handleFiles(files: File[]) {
    if (!files.length) {
      return;
    }
    setIsParsing(true);
    try {
      const results = await Promise.all(files.map((file) => parsePrintFile(file)));
      const newItems = results.map((result, index) => makeQuoteItem(result, files[index].name, pricing));
      setQuoteItems((previous) => [...previous, ...newItems]);
      setParsed(results[0] ?? null);
      setItemName((previous) => {
        if (previous !== "Stampa personalizzata") {
          return previous;
        }
        return files.length === 1 && !quoteItems.length ? files[0].name : "Preventivo multiprodotto";
      });
      if (newItems.length === 1 && !quoteItems.length) {
        const item = newItems[0];
        setPricing((previous) => ({
          ...suggestPricingFromMetrics(item.metrics, previous),
          quantity: item.quantity,
          manualMinutes: item.manualMinutes,
          filamentGrams: item.filamentGrams,
        }));
      }
    } finally {
      setIsParsing(false);
      setDragActive(false);
    }
  }

  async function handleFile(file: File) {
    await handleFiles([file]);
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length) {
      void handleFiles(files);
    }
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) {
      void handleFiles(files);
    }
  }

  async function handleProductFile(file: File) {
    setIsParsingProduct(true);
    try {
      const result = await parsePrintFile(file);
      const suggested = suggestPricingFromMetrics(result.metrics, {
        ...DEFAULT_PRICING,
        quantity: productDraft.defaultQuantity,
        color: productDraft.color,
        finish: productDraft.finish,
      });
      setProductSource(result);
      setProductDraft((previous) => ({
        ...previous,
        name: previous.name.trim() ? previous.name : stripFileExtension(file.name),
        defaultMinutes: suggested.manualMinutes,
        defaultGrams: suggested.filamentGrams,
      }));
    } finally {
      setIsParsingProduct(false);
      setProductDragActive(false);
    }
  }

  function handleProductFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void handleProductFile(file);
    }
    event.target.value = "";
  }

  function handleProductDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) {
      void handleProductFile(file);
    }
  }

  function patchPricing(update: Partial<PricingInputs>) {
    setPricing((previous) => ({
      ...previous,
      ...update,
      materialKey: "pla",
      machineRate: PRINTER_PROFILE.machineRate,
      powerKw: update.powerKw ?? previous.powerKw ?? PRINTER_PROFILE.defaultAveragePowerKw,
      energyCostKwh: PRINTER_PROFILE.energyCostKwh,
      marginPercent: 125,
    }));
  }

  function updateQuoteItem(itemId: string, update: Partial<Pick<QuoteItem, "name" | "quantity" | "manualMinutes" | "filamentGrams" | "manualPrice">>) {
    setQuoteItems((previous) =>
      previous.map((item) => {
        if (item.id !== itemId) {
          return item;
        }
        const next = {
          ...item,
          ...update,
          quantity: update.quantity !== undefined ? Math.max(1, update.quantity) : item.quantity,
          manualMinutes: update.manualMinutes !== undefined ? Math.max(1, update.manualMinutes) : item.manualMinutes,
          filamentGrams: update.filamentGrams !== undefined ? Math.max(1, update.filamentGrams) : item.filamentGrams,
          manualPrice: update.manualPrice !== undefined ? normalizeManualPrice(update.manualPrice) : item.manualPrice,
        };
        return {
          ...next,
          metrics: {
            ...next.metrics,
            fileName: next.name || next.fileName,
            printTimeMinutes: next.manualMinutes,
            filamentGrams: next.filamentGrams,
          },
        };
      }),
    );
  }

  function deleteQuoteItem(itemId: string) {
    setQuoteItems((previous) => previous.filter((item) => item.id !== itemId));
  }

  function clearQuoteItems() {
    setQuoteItems([]);
    setParsed(null);
    setItemName("Stampa personalizzata");
    patchPricing({
      quantity: DEFAULT_PRICING.quantity,
      manualMinutes: DEFAULT_PRICING.manualMinutes,
      filamentGrams: DEFAULT_PRICING.filamentGrams,
    });
  }

  function saveCurrentOrder(status: OrderStatus = "Bozza") {
    const now = new Date();
    const order: Order = {
      id: makeOrderId(),
      quoteNumber: makeQuoteNumber(now),
      createdAt: now.toISOString(),
      status,
      customer,
      customerNumber,
      fileName: itemName || quoteMetrics.fileName,
      materialKey: "pla",
      quantity: quoteItems.length ? quoteTotals.quantity : pricing.quantity,
      color: pricing.color,
      finish: pricing.finish,
      averagePowerKw: pricing.powerKw,
      energyCostKwh: pricing.energyCostKwh,
      machineRate: pricing.machineRate,
      marginPercent: pricing.marginPercent,
      includeVat: pricing.includeVat,
      vatPercent: pricing.vatPercent,
      netPrice: breakdown.netPrice,
      grossPrice: breakdown.grossPrice,
      metrics: quoteMetrics,
      items: quoteItems.length ? quoteItems : undefined,
      notes,
    };
    setOrders((previous) => [order, ...previous]);
    setView("storico");
  }

  function updateOrderStatus(orderId: string, status: OrderStatus) {
    setOrders((previous) => previous.map((order) => (order.id === orderId ? { ...order, status } : order)));
  }

  function deleteOrder(orderId: string) {
    setOrders((previous) => previous.filter((order) => order.id !== orderId));
  }

  function generateQuote() {
    openQuote({
      quoteNumber: makeQuoteNumber(),
      customer,
      customerNumber,
      metrics: quoteMetrics,
      pricing,
      breakdown,
      items: pricedQuote.rows,
      notes,
    });
  }

  function saveFrequentProduct() {
    const trimmedName = productDraft.name.trim();
    if (!trimmedName || !productSource) {
      return;
    }
    const product: FrequentProduct = {
      id: makeOrderId(),
      ...productDraft,
      name: trimmedName,
      sku: productDraft.sku.trim(),
      sourceFileName: productSource.metrics.fileName,
      sourceKind: productSource.metrics.kind,
      sourceFileSize: productSource.metrics.fileSize,
      boundingBox: productSource.metrics.boundingBox,
      layerCount: productSource.metrics.layerCount,
      volumeCm3: productSource.metrics.volumeCm3,
      warnings: productSource.metrics.warnings,
      notes: productDraft.notes.trim(),
      defaultQuantity: Math.max(1, productDraft.defaultQuantity),
      defaultMinutes: Math.max(1, productDraft.defaultMinutes),
      defaultGrams: Math.max(1, productDraft.defaultGrams),
    };
    setProducts((previous) => [product, ...previous]);
    setProductDraft(EMPTY_PRODUCT);
    setProductSource(null);
  }

  function deleteProduct(productId: string) {
    setProducts((previous) => previous.filter((product) => product.id !== productId));
    setSelectedProductIds((previous) => previous.filter((id) => id !== productId));
  }

  function updateProductManualPrice(productId: string, manualPrice: number) {
    setProducts((previous) =>
      previous.map((product) =>
        product.id === productId ? { ...product, manualPrice: normalizeManualPrice(manualPrice) } : product,
      ),
    );
  }

  function applyProduct(product: FrequentProduct) {
    applyProducts([product], {
      copySingleProductNotes: true,
      defaultQuoteName: "Preventivo multiprodotto",
    });
  }

  function applySelectedProducts() {
    applyProducts(selectedProducts, {
      defaultQuoteName: selectedProducts.length === 1 ? selectedProducts[0].name : `Preventivo ${selectedProducts.length} prodotti frequenti`,
    });
    setSelectedProductIds([]);
  }

  function applyAllProducts() {
    applyProducts(products, {
      defaultQuoteName: products.length === 1 ? products[0].name : `Preventivo ${products.length} prodotti frequenti`,
    });
    setSelectedProductIds([]);
  }

  function applyProducts(
    productsToApply: FrequentProduct[],
    options: { copySingleProductNotes?: boolean; defaultQuoteName?: string } = {},
  ) {
    if (!productsToApply.length) {
      return;
    }
    const newItems = productsToApply.map(makeProductQuoteItem);
    const firstProduct = productsToApply[0];
    const sameColor = productsToApply.every((product) => product.color === firstProduct.color);
    const sameFinish = productsToApply.every((product) => product.finish === firstProduct.finish);
    setQuoteItems((previous) => [...previous, ...newItems]);
    setParsed({
      metrics: newItems[0].metrics,
      preview: { kind: "empty", message: "Prodotti richiamati dal catalogo." },
    });
    setItemName((previous) => {
      if (previous !== "Stampa personalizzata") {
        return previous;
      }
      return options.defaultQuoteName ?? "Preventivo multiprodotto";
    });
    patchPricing({
      ...(sameColor ? { color: firstProduct.color } : {}),
      ...(sameFinish ? { finish: firstProduct.finish } : {}),
    });
    if (options.copySingleProductNotes && firstProduct.notes) {
      setNotes(firstProduct.notes);
    }
    setView("nuovo");
  }

  function toggleProductSelection(productId: string, checked: boolean) {
    setSelectedProductIds((previous) =>
      checked ? Array.from(new Set([...previous, productId])) : previous.filter((id) => id !== productId),
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Gestionale personale</p>
          <h1>Ordini stampa 3D</h1>
        </div>
        <div className="topbar-metrics">
          <MetricPill icon={<Archive size={17} />} label="Ordini" value={orders.length.toString()} />
          <MetricPill icon={<Calculator size={17} />} label="Preventivo" value={formatCurrency(breakdown.grossPrice)} />
        </div>
      </header>

      <nav className="main-tabs" aria-label="Sezioni gestionale">
        <button className={view === "nuovo" ? "is-selected" : ""} onClick={() => setView("nuovo")}>
          <ReceiptText size={18} />
          Nuovo ordine
        </button>
        <button className={view === "storico" ? "is-selected" : ""} onClick={() => setView("storico")}>
          <History size={18} />
          Storico
        </button>
        <button className={view === "prodotti" ? "is-selected" : ""} onClick={() => setView("prodotti")}>
          <Package size={18} />
          Prodotti frequenti
        </button>
      </nav>

      {view === "nuovo" && (
        <section className="quote-grid">
          <div className="left-rail">
            <label
              className={`upload-zone ${dragActive ? "is-active" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
            >
              <input accept=".3mf,.gcode,.gco,.gc" multiple type="file" onChange={handleFileInput} />
              <Upload size={24} />
              <span>{isParsing ? "Analisi in corso..." : "Carica uno o piu G-code/3MF"}</span>
              <small>Puoi selezionare piu file insieme per un unico preventivo</small>
            </label>

            {quoteItems.length ? (
              <button className="danger-button full-width" onClick={clearQuoteItems}>
                <Trash2 size={18} />
                Elimina tutto
              </button>
            ) : null}

            <section className="panel">
              <PanelTitle icon={<FileArchive size={18} />} title={quoteItems.length ? "Prodotti caricati" : "Dati stampa"} />
              <div className="metric-list">
                <TextField label={quoteItems.length ? "Nome preventivo" : "Prodotto / lavorazione"} value={itemName} onChange={setItemName} />
                {quoteItems.length ? (
                  <>
                    <div className="quote-summary-strip">
                      <InfoRow label="File" value={quoteTotals.files.toString()} />
                      <InfoRow label="Pezzi" value={quoteTotals.quantity.toString()} />
                      <InfoRow label="Tempo totale" value={`${formatNumber(quoteTotals.minutes)} min`} />
                      <InfoRow label="Filamento totale" value={`${formatNumber(quoteTotals.grams)} g`} />
                    </div>
                    <div className="quote-item-list">
                      {quoteItems.map((item) => (
                        <article className="quote-item-card" key={item.id}>
                          <div className="quote-item-head">
                            <div>
                              <strong>{item.name}</strong>
                              <span>{item.fileName}</span>
                            </div>
                            <button className="icon-button danger" title="Elimina prodotto" onClick={() => deleteQuoteItem(item.id)}>
                              <Trash2 size={17} />
                            </button>
                          </div>
                          <div className="quote-item-fields">
                            <TextField label="Nome" value={item.name} onChange={(name) => updateQuoteItem(item.id, { name })} />
                            <NumberField label="Pezzi" min={1} step={1} value={item.quantity} onChange={(quantity) => updateQuoteItem(item.id, { quantity })} />
                            <NumberField
                              label="Tempo min"
                              min={1}
                              step={5}
                              value={item.manualMinutes}
                              onChange={(manualMinutes) => updateQuoteItem(item.id, { manualMinutes })}
                            />
                            <NumberField
                              label="Filamento g"
                              min={1}
                              step={1}
                              value={item.filamentGrams}
                              onChange={(filamentGrams) => updateQuoteItem(item.id, { filamentGrams })}
                            />
                            <NumberField
                              className="manual-price-field"
                              label="Prezzo manuale € (0 auto)"
                              min={0}
                              step={1}
                              value={item.manualPrice ?? 0}
                              onChange={(manualPrice) => updateQuoteItem(item.id, { manualPrice })}
                            />
                          </div>
                          <div className="product-meta">
                            <span>
                              <FileArchive size={15} />
                              {item.kind.toUpperCase()}
                            </span>
                            {item.metrics.boundingBox && (
                              <span>
                                <Package size={15} />
                                {formatNumber(item.metrics.boundingBox.x)} x {formatNumber(item.metrics.boundingBox.y)} mm
                              </span>
                            )}
                            {item.metrics.layerCount && (
                              <span>
                                <Archive size={15} />
                                {item.metrics.layerCount} layer
                              </span>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  </>
                ) : parsed ? (
                  <>
                    <InfoRow label="File" value={parsed.metrics.fileName} />
                    <InfoRow label="Tipo" value={parsed.metrics.kind.toUpperCase()} />
                    {parsed.metrics.boundingBox && (
                      <InfoRow
                        label="Ingombro"
                        value={`${formatNumber(parsed.metrics.boundingBox.x)} x ${formatNumber(parsed.metrics.boundingBox.y)} x ${formatNumber(parsed.metrics.boundingBox.z)} mm`}
                      />
                    )}
                    {parsed.metrics.layerCount && <InfoRow label="Layer" value={parsed.metrics.layerCount.toString()} />}
                  </>
                ) : (
                  <p className="muted">Puoi creare un preventivo anche senza file, inserendo minuti e grammi.</p>
                )}
              </div>
            </section>

            {quoteWarnings.length ? (
              <section className="panel warning-panel">
                <PanelTitle icon={<AlertTriangle size={18} />} title="Da controllare" />
                <ul className="warning-list">
                  {quoteWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <section className="center-stack">
            <section className="panel locked-panel">
              <PanelTitle icon={<Lock size={18} />} title="Parametri fissi" />
              <div className="locked-grid">
                <LockedItem icon={<Printer size={18} />} label="Stampante" value={PRINTER_PROFILE.name} />
                <LockedItem icon={<Clock3 size={18} />} label="Potenza nominale" value={`${formatNumber(PRINTER_PROFILE.ratedPowerKw, 2)} kW`} />
                <LockedItem
                  icon={<Weight size={18} />}
                  label="Consumo default"
                  value={`${formatNumber(PRINTER_PROFILE.averagePowerFactor * 100)}% = ${formatNumber(PRINTER_PROFILE.defaultAveragePowerKw, 2)} kW`}
                />
                <LockedItem icon={<Package size={18} />} label="Materiale" value={`${selectedMaterial.name} ${formatCurrency(selectedMaterial.costPerKg)}/kg`} />
                <LockedItem icon={<Calculator size={18} />} label="Energia" value={`${formatCurrency(PRINTER_PROFILE.energyCostKwh)}/kWh`} />
                <LockedItem icon={<Lock size={18} />} label="Costo macchina" value={`${formatCurrency(PRINTER_PROFILE.machineRate)}/h`} />
                <LockedItem icon={<Sparkles size={18} />} label="Guadagno" value="125% sulle spese vive" />
              </div>
            </section>

            <section className="panel">
              <PanelTitle icon={<Calculator size={18} />} title="Preventivo" />
              <div className="form-grid compact">
                {quoteItems.length ? (
                  <div className="quote-total-summary wide-field">
                    <InfoRow label="Prodotti" value={`${quoteTotals.files} file / ${quoteTotals.quantity} pz`} />
                    <InfoRow label="Tempo totale" value={`${formatNumber(quoteTotals.minutes)} min`} />
                    <InfoRow label="Filamento totale" value={`${formatNumber(quoteTotals.grams)} g`} />
                  </div>
                ) : (
                  <>
                    <NumberField label="Quantita" min={1} step={1} value={pricing.quantity} onChange={(quantity) => patchPricing({ quantity })} />
                    <NumberField
                      label="Tempo stampa min"
                      min={1}
                      step={5}
                      value={pricing.manualMinutes}
                      onChange={(manualMinutes) => patchPricing({ manualMinutes })}
                    />
                    <NumberField
                      label="Filamento g"
                      min={1}
                      step={1}
                      value={pricing.filamentGrams}
                      onChange={(filamentGrams) => patchPricing({ filamentGrams })}
                    />
                  </>
                )}
                <NumberField
                  label="Potenza media misurata kW"
                  min={0.01}
                  step={0.01}
                  value={pricing.powerKw}
                  onChange={(powerKw) => patchPricing({ powerKw })}
                />
                <ToggleOption
                  checked={pricing.color === "Colore"}
                  description="Bianco e nero restano prezzo base"
                  label={`Altro colore + ${formatCurrency(SURCHARGES.color)}`}
                  onChange={(checked) => patchPricing({ color: checked ? "Colore" : "Bianco" })}
                />
                <ToggleOption
                  checked={pricing.finish === "Effetto pietra"}
                  description="Aggiunge il supplemento finitura"
                  label={`Effetto pietra + ${formatCurrency(SURCHARGES.stoneEffect)}`}
                  onChange={(checked) => patchPricing({ finish: checked ? "Effetto pietra" : "Standard" })}
                />
                <label className="toggle-row">
                  <input
                    checked={pricing.includeVat}
                    type="checkbox"
                    onChange={(event) => patchPricing({ includeVat: event.target.checked })}
                  />
                  Applica IVA {pricing.vatPercent}%
                </label>
              </div>
            </section>

            <section className="panel">
              <PanelTitle icon={<UserRound size={18} />} title="Cliente" />
              <div className="form-grid">
                <TextField label="Nome cliente" value={customer.name} onChange={(name) => setCustomer((previous) => ({ ...previous, name }))} />
                <TextField label="Numero cliente" value={customerNumber} onChange={setCustomerNumber} />
                <TextField label="Telefono" value={customer.phone} onChange={(phone) => setCustomer((previous) => ({ ...previous, phone }))} />
                <TextField label="Email" value={customer.email} onChange={(email) => setCustomer((previous) => ({ ...previous, email }))} />
                <label className="wide-field">
                  Note
                  <textarea value={notes} rows={3} onChange={(event) => setNotes(event.target.value)} />
                </label>
              </div>
            </section>
          </section>

          <aside className="right-rail">
            <section className="panel total-panel">
              <div className="total-row">
                <span>Prezzo finale</span>
                <strong>{formatCurrency(breakdown.grossPrice)}</strong>
              </div>
              <div className="breakdown">
                {quoteItems.length ? (
                  <>
                    <InfoRow label="Prodotti" value={`${quoteTotals.files} file / ${quoteTotals.quantity} pz`} />
                    {pricedQuote.rows.map((row) => (
                      <InfoRow key={row.item.id} label={`${row.item.quantity} x ${row.item.name}`} value={formatCurrency(row.breakdown.grossPrice)} />
                    ))}
                  </>
                ) : null}
                <InfoRow label="Materiale PLA" value={formatCurrency(breakdown.materialCost)} />
                <InfoRow label={`Energia ${formatNumber(pricing.powerKw, 2)} kW`} value={formatCurrency(breakdown.energyCost)} />
                <InfoRow label="Macchina" value={formatCurrency(breakdown.machineCost)} />
                <InfoRow label="Spese vive" value={formatCurrency(breakdown.subtotalCost)} />
                <InfoRow label="Guadagno 125%" value={formatCurrency(breakdown.marginAmount)} />
                {breakdown.colorSurcharge > 0 && <InfoRow label="Colore" value={formatCurrency(breakdown.colorSurcharge)} />}
                {breakdown.finishSurcharge > 0 && <InfoRow label="Effetto pietra" value={formatCurrency(breakdown.finishSurcharge)} />}
                {pricing.quantity > 1 && <InfoRow label="Prezzo unitario" value={formatCurrency(breakdown.unitPrice)} />}
              </div>
            </section>

            <section className="panel quick-products">
              <PanelTitle icon={<Package size={18} />} title="Prodotti frequenti" />
              {products.length ? (
                <div className="quick-product-list">
                  {products.slice(0, 5).map((product) => (
                    <button key={product.id} onClick={() => applyProduct(product)}>
                      <span>
                        <strong>{product.name}</strong>
                        <small>
                          {formatNumber(product.defaultMinutes)} min · {formatNumber(product.defaultGrams)} g
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="muted">Aggiungi prodotti nella terza schermata per richiamarli qui.</p>
              )}
            </section>

            <section className="panel action-panel">
              <button className="primary-button" onClick={generateQuote}>
                <ReceiptText size={18} />
                Preventivo
              </button>
              <button className="secondary-button" onClick={() => saveCurrentOrder("Bozza")}>
                <Save size={18} />
                Salva nello storico
              </button>
            </section>
          </aside>
        </section>
      )}

      {view === "storico" && (
        <section className="screen-section">
          <div className="orders-header">
            <div>
              <p className="eyebrow">Archivio</p>
              <h2>Storico ordini</h2>
            </div>
            <div className="status-tabs" role="tablist" aria-label="Filtra ordini">
              {(["Tutti", ...STATUSES] as const).map((status) => (
                <button
                  key={status}
                  className={activeStatus === status ? "is-selected" : ""}
                  onClick={() => setActiveStatus(status)}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>

          <div className="orders-table">
            {filteredOrders.length ? (
              filteredOrders.map((order) => (
                <article className="order-row" key={order.id}>
                  <div>
                    <strong>{order.quoteNumber}</strong>
                    <span>{new Date(order.createdAt).toLocaleDateString("it-IT")}</span>
                  </div>
                  <div>
                    <strong>{order.customer.name || "Cliente senza nome"}</strong>
                    <span>Cliente n. {order.customerNumber || order.customer.phone || "-"}</span>
                  </div>
                  <div>
                    <strong>{order.fileName}</strong>
                    <span>
                      {order.items?.length
                        ? `${order.items.length} prodotti / ${order.quantity} pz · opzioni per prodotto`
                        : `${order.quantity} pz · ${order.color || "Bianco"} · ${order.finish || "Standard"}`}
                    </span>
                  </div>
                  <div>
                    <strong>{formatCurrency(order.grossPrice)}</strong>
                    <span>
                      {formatNumber(order.metrics.printTimeMinutes ?? 0)} min · {formatNumber(order.averagePowerKw ?? PRINTER_PROFILE.defaultAveragePowerKw, 2)} kW
                    </span>
                  </div>
                  <select value={order.status} onChange={(event) => updateOrderStatus(order.id, event.target.value as OrderStatus)}>
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                  <div className="row-actions">
                    <button title="Apri preventivo" onClick={() => openOrderQuote(order)}>
                      <FileText size={17} />
                    </button>
                    <button title="Elimina ordine" onClick={() => deleteOrder(order.id)}>
                      <Trash2 size={17} />
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <div className="empty-orders">
                <Archive size={24} />
                <span>Nessun ordine salvato in questo filtro.</span>
              </div>
            )}
          </div>
        </section>
      )}

      {view === "prodotti" && (
        <section className="products-layout">
          <section className="panel product-builder">
            <PanelTitle icon={<PlusCircle size={18} />} title="Nuovo prodotto da file" />
            <div className="product-builder-grid">
              <label
                className={`upload-zone product-upload ${productDragActive ? "is-active" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setProductDragActive(true);
                }}
                onDragLeave={() => setProductDragActive(false)}
                onDrop={handleProductDrop}
              >
                <input accept=".3mf,.gcode,.gco,.gc" type="file" onChange={handleProductFileInput} />
                <Upload size={24} />
                <span>{isParsingProduct ? "Calcolo prodotto..." : "Carica file prodotto"}</span>
                <small>Il prodotto frequente viene salvato solo dopo un file G-code o 3MF</small>
              </label>

              <div className="product-file-summary">
                {productSource ? (
                  <>
                    <InfoRow label="File" value={productSource.metrics.fileName} />
                    <InfoRow label="Tipo" value={productSource.metrics.kind.toUpperCase()} />
                    <InfoRow label="Tempo" value={`${formatNumber(productDraft.defaultMinutes)} min`} />
                    <InfoRow label="Filamento" value={`${formatNumber(productDraft.defaultGrams)} g`} />
                    {productSource.metrics.boundingBox && (
                      <InfoRow
                        label="Ingombro"
                        value={`${formatNumber(productSource.metrics.boundingBox.x)} x ${formatNumber(productSource.metrics.boundingBox.y)} x ${formatNumber(productSource.metrics.boundingBox.z)} mm`}
                      />
                    )}
                    {productSource.metrics.layerCount && <InfoRow label="Layer" value={productSource.metrics.layerCount.toString()} />}
                  </>
                ) : (
                  <div className="file-placeholder">
                    <FileArchive size={24} />
                    <span>Nessun file prodotto caricato.</span>
                  </div>
                )}
              </div>
            </div>

            {productSource?.metrics.warnings.length ? (
              <ul className="warning-list product-warnings">
                {productSource.metrics.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}

            <div className="form-grid product-details">
              <TextField label="Nome prodotto" value={productDraft.name} onChange={(name) => setProductDraft((previous) => ({ ...previous, name }))} />
              <TextField label="Codice / SKU" value={productDraft.sku} onChange={(sku) => setProductDraft((previous) => ({ ...previous, sku }))} />
              <NumberField
                label="Quantita default"
                min={1}
                step={1}
                value={productDraft.defaultQuantity}
                onChange={(defaultQuantity) => setProductDraft((previous) => ({ ...previous, defaultQuantity }))}
              />
              <NumberField
                label="Prezzo manuale € (0 auto)"
                min={0}
                step={1}
                value={productDraft.manualPrice ?? 0}
                onChange={(manualPrice) => setProductDraft((previous) => ({ ...previous, manualPrice: normalizeManualPrice(manualPrice) }))}
              />
              <ToggleOption
                checked={productDraft.color === "Colore"}
                description="Bianco e nero restano prezzo base"
                label={`Altro colore + ${formatCurrency(SURCHARGES.color)}`}
                onChange={(checked) => setProductDraft((previous) => ({ ...previous, color: checked ? "Colore" : "Bianco" }))}
              />
              <ToggleOption
                checked={productDraft.finish === "Effetto pietra"}
                description="Aggiunge il supplemento finitura"
                label={`Effetto pietra + ${formatCurrency(SURCHARGES.stoneEffect)}`}
                onChange={(checked) => setProductDraft((previous) => ({ ...previous, finish: checked ? "Effetto pietra" : "Standard" }))}
              />
              <label className="wide-field">
                Note prodotto
                <textarea value={productDraft.notes} rows={3} onChange={(event) => setProductDraft((previous) => ({ ...previous, notes: event.target.value }))} />
              </label>
            </div>
            <div className="button-row">
              <button className="primary-button" disabled={!productDraft.name.trim() || !productSource} onClick={saveFrequentProduct}>
                <Save size={18} />
                Salva prodotto
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="catalog-header">
              <PanelTitle icon={<Package size={18} />} title="Catalogo rapido" />
              {products.length ? <span>{selectedProducts.length} selezionati</span> : null}
            </div>
            {products.length ? (
              <div className="catalog-actions">
                <button className="secondary-button" onClick={() => setSelectedProductIds(products.map((product) => product.id))}>
                  Seleziona tutti
                </button>
                <button className="secondary-button" disabled={!selectedProducts.length} onClick={() => setSelectedProductIds([])}>
                  Deseleziona
                </button>
                <button className="primary-button" disabled={!selectedProducts.length} onClick={applySelectedProducts}>
                  <ReceiptText size={18} />
                  Usa selezionati
                </button>
                <button className="secondary-button" onClick={applyAllProducts}>
                  <Package size={18} />
                  Usa tutti
                </button>
              </div>
            ) : null}
            <div className="product-catalog">
              {products.length ? (
                products.map((product) => (
                  <article className={`product-card ${selectedProductIds.includes(product.id) ? "is-selected" : ""}`} key={product.id}>
                    <div className="product-card-head">
                      <div>
                        <strong>{product.name}</strong>
                        <span>{product.sku || product.sourceFileName || "Senza codice"}</span>
                      </div>
                      <label className="product-select">
                        <input
                          checked={selectedProductIds.includes(product.id)}
                          type="checkbox"
                          onChange={(event) => toggleProductSelection(product.id, event.target.checked)}
                        />
                        <span>Seleziona</span>
                      </label>
                    </div>
                    <div className="product-meta">
                      <span>
                        <Clock3 size={15} />
                        {formatNumber(product.defaultMinutes)} min
                      </span>
                      <span>
                        <Weight size={15} />
                        {formatNumber(product.defaultGrams)} g
                      </span>
                      <span>
                        <Palette size={15} />
                        {product.color}
                      </span>
                      <span>
                        <Sparkles size={15} />
                        {product.finish}
                      </span>
                      <span>
                        <Calculator size={15} />
                        {formatCurrency(calculateProductPrice(product))}
                      </span>
                    </div>
                    <div className="product-source">
                      <InfoRow label="File" value={product.sourceFileName ?? "Prodotto precedente senza file"} />
                      {product.boundingBox && (
                        <InfoRow
                          label="Ingombro"
                          value={`${formatNumber(product.boundingBox.x)} x ${formatNumber(product.boundingBox.y)} x ${formatNumber(product.boundingBox.z)} mm`}
                        />
                      )}
                      <NumberField
                        label="Prezzo manuale € (0 auto)"
                        min={0}
                        step={1}
                        value={product.manualPrice ?? 0}
                        onChange={(manualPrice) => updateProductManualPrice(product.id, manualPrice)}
                      />
                    </div>
                    {product.notes && <p>{product.notes}</p>}
                    <div className="button-row">
                      <button className="secondary-button" onClick={() => applyProduct(product)}>
                        <ReceiptText size={18} />
                        Usa
                      </button>
                      <button className="icon-button danger" title="Elimina prodotto" onClick={() => deleteProduct(product.id)}>
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-orders">
                  <Package size={24} />
                  <span>Nessun prodotto frequente inserito.</span>
                </div>
              )}
            </div>
          </section>
        </section>
      )}
    </main>
  );
}

function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function MetricPill({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="metric-pill">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ToggleOption({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="switch-field">
      <input checked={checked} role="switch" type="checkbox" onChange={(event) => onChange(event.target.checked)} />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      <span className="switch-copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function LockedItem({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="locked-item">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NumberField({
  className,
  label,
  value,
  min,
  step,
  onChange,
}: {
  className?: string;
  label: string;
  value: number;
  min: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className={className}>
      {label}
      <input
        min={min}
        step={step}
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function makeManualMetrics(itemName: string, pricing: PricingInputs): PrintMetrics {
  return {
    fileName: itemName || "Ordine manuale",
    fileSize: 0,
    kind: "unknown",
    printTimeMinutes: pricing.manualMinutes,
    filamentGrams: pricing.filamentGrams,
    warnings: [],
  };
}

function makeQuoteMetrics(itemName: string, items: QuoteItem[]): PrintMetrics {
  const firstKind = items[0]?.kind ?? "unknown";
  const sameKind = items.every((item) => item.kind === firstKind);
  return {
    fileName: itemName.trim() || (items.length === 1 ? items[0].name : `${items.length} prodotti`),
    fileSize: items.reduce((total, item) => total + item.metrics.fileSize, 0),
    kind: sameKind ? firstKind : "unknown",
    printTimeMinutes: items.reduce((total, item) => total + item.manualMinutes * item.quantity, 0),
    filamentGrams: items.reduce((total, item) => total + item.filamentGrams * item.quantity, 0),
    warnings: Array.from(new Set(items.flatMap((item) => item.metrics.warnings))),
  };
}

function makeQuoteItem(parsedFile: ParsedFile, fileName: string, pricing: PricingInputs): QuoteItem {
  const suggested = suggestPricingFromMetrics(parsedFile.metrics, pricing);
  return {
    id: makeOrderId(),
    name: stripFileExtension(fileName),
    fileName: parsedFile.metrics.fileName,
    kind: parsedFile.metrics.kind,
    quantity: 1,
    manualMinutes: suggested.manualMinutes,
    filamentGrams: suggested.filamentGrams,
    metrics: {
      ...parsedFile.metrics,
      printTimeMinutes: suggested.manualMinutes,
      filamentGrams: suggested.filamentGrams,
    },
  };
}

function makeProductQuoteItem(product: FrequentProduct): QuoteItem {
  return {
    id: makeOrderId(),
    name: product.name,
    fileName: product.sourceFileName ?? product.name,
    kind: product.sourceKind ?? "unknown",
    quantity: product.defaultQuantity,
    manualMinutes: product.defaultMinutes,
    filamentGrams: product.defaultGrams,
    manualPrice: product.manualPrice,
    color: product.color,
    finish: product.finish,
    metrics: {
      fileName: product.sourceFileName ?? product.name,
      fileSize: product.sourceFileSize ?? 0,
      kind: product.sourceKind ?? "unknown",
      printTimeMinutes: product.defaultMinutes,
      filamentGrams: product.defaultGrams,
      boundingBox: product.boundingBox,
      layerCount: product.layerCount,
      volumeCm3: product.volumeCm3,
      warnings: product.warnings ?? [],
    },
  };
}

function combinePriceBreakdowns(breakdowns: PriceBreakdown[]): PriceBreakdown {
  const total = breakdowns.reduce<PriceBreakdown>(
    (sum, breakdown) => ({
      materialCost: sum.materialCost + breakdown.materialCost,
      energyCost: sum.energyCost + breakdown.energyCost,
      machineCost: sum.machineCost + breakdown.machineCost,
      laborCost: sum.laborCost + breakdown.laborCost,
      setupFee: sum.setupFee + breakdown.setupFee,
      riskBuffer: sum.riskBuffer + breakdown.riskBuffer,
      subtotalCost: sum.subtotalCost + breakdown.subtotalCost,
      marginAmount: sum.marginAmount + breakdown.marginAmount,
      netPrice: sum.netPrice + breakdown.netPrice,
      vatAmount: sum.vatAmount + breakdown.vatAmount,
      grossPrice: sum.grossPrice + breakdown.grossPrice,
      unitPrice: 0,
      colorSurcharge: sum.colorSurcharge + breakdown.colorSurcharge,
      finishSurcharge: sum.finishSurcharge + breakdown.finishSurcharge,
    }),
    {
      materialCost: 0,
      energyCost: 0,
      machineCost: 0,
      laborCost: 0,
      setupFee: 0,
      riskBuffer: 0,
      subtotalCost: 0,
      marginAmount: 0,
      netPrice: 0,
      vatAmount: 0,
      grossPrice: 0,
      unitPrice: 0,
      colorSurcharge: 0,
      finishSurcharge: 0,
    },
  );
  return {
    ...total,
    unitPrice: total.grossPrice / Math.max(1, breakdowns.length),
  };
}

function applyManualPriceToBreakdown(
  breakdown: PriceBreakdown,
  manualPrice: number | undefined,
  quantity: number,
  pricing: PricingInputs,
): PriceBreakdown {
  const normalizedManualPrice = normalizeManualPrice(manualPrice ?? 0);
  if (!normalizedManualPrice) {
    return breakdown;
  }
  const vatRate = pricing.includeVat ? pricing.vatPercent / 100 : 0;
  const netPrice = vatRate ? roundMoney(normalizedManualPrice / (1 + vatRate)) : normalizedManualPrice;
  const vatAmount = normalizedManualPrice - netPrice;
  return {
    ...breakdown,
    netPrice,
    vatAmount,
    grossPrice: normalizedManualPrice,
    unitPrice: normalizedManualPrice / Math.max(1, quantity),
  };
}

function normalizeManualPrice(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function calculateProductPrice(product: FrequentProduct): number {
  const automaticBreakdown = calculatePrice({
    ...DEFAULT_PRICING,
    quantity: product.defaultQuantity,
    manualMinutes: product.defaultMinutes,
    filamentGrams: product.defaultGrams,
    color: product.color,
    finish: product.finish,
  });
  return applyManualPriceToBreakdown(automaticBreakdown, product.manualPrice, product.defaultQuantity, DEFAULT_PRICING).grossPrice;
}

export default App;

const DEMO_GCODE = `; generated by Gestionale stampa 3D demo
; printer_model = Anycubic Kobra X
; filament_type = PLA
;TIME:5400
;Filament used [g] = 20.5
;Filament used [m] = 6.8
G90
M82
G92 E0
G1 X0 Y0 Z0.2 F3000
G1 X70 Y0 E1.2 F1500
G1 X70 Y42 E2.3
G1 X0 Y42 E3.4
G1 X0 Y0 E4.5
G1 Z0.4 F1200
G1 X2 Y2 E10.1
G1 X68 Y2 E11.1
G1 X68 Y40 E12.2
G1 X2 Y40 E13.3
G1 X2 Y2 E14.4
G1 Z0.6 F1200
G1 X4 Y4 E18.3
G1 X66 Y4 E19.3
G1 X66 Y38 E20.3
G1 X4 Y38 E21.3
G1 X4 Y4 E22.3
`;
