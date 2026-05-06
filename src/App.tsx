import React, { useState, useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { cn } from './lib/utils';
import { GoogleGenAI } from '@google/genai';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

export default function App() {
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('PROCESSING...');
  const [toast, setToast] = useState({ show: false, msg: '', type: 'info' });
  const [activeTab, setActiveTab] = useState('edit');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState('');
  const [editsMade, setEditsMade] = useState(false);
  
  const [geminiPrompt, setGeminiPrompt] = useState('');

  const [toolbarValues, setToolbarValues] = useState({
    fontFamily: 'Arial',
    fontSize: '12',
    color: '#000000',
  });

  const pageStoreRef = useRef<any>({});
  const activeTextBlockRef = useRef<any>(null);
  const currentEditorRef = useRef<any>(null);
  
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const pageThumbsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = (msg: string, type = 'info') => {
    setToast({ show: true, msg, type });
    setTimeout(() => setToast(prev => ({ ...prev, show: false })), 3500);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadPDF(file);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') loadPDF(file);
    else showToast('Please drop a valid PDF file', 'error');
  };

  const loadPDF = async (file: File) => {
    setIsLoading(true);
    setLoadingText('READING PDF...');
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfBytes = new Uint8Array(arrayBuffer);
      const doc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
      
      setTotalPages(doc.numPages);
      setFileName(file.name);
      setFileSize((file.size / 1024).toFixed(1) + ' KB');
      setPdfDoc(doc);
      
      if (canvasAreaRef.current) canvasAreaRef.current.innerHTML = '';
      if (pageThumbsRef.current) pageThumbsRef.current.innerHTML = '';
      pageStoreRef.current = {};
      
      for (let i = 1; i <= doc.numPages; i++) {
        await renderPage(doc, i);
      }
      
      setIsLoaded(true);
      showToast('PDF loaded — click any text to edit it!', 'success');
    } catch (err: any) {
      showToast('Error loading PDF: ' + err.message, 'error');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const renderPage = async (doc: any, pageNum: number) => {
    const scale = 1.5;
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const textContent = await page.getTextContent();

    const textItems: any[] = [];
    textContent.items.forEach((item: any, idx: number) => {
      if (!item.str) return;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
      const angle = Math.atan2(tx[1], tx[0]);
      textItems.push({
        idx, str: item.str, tx, fontHeight, angle,
        fontName: item.fontName || '',
        width: item.width * scale,
        x: tx[4], y: tx[5]
      });
    });

    pageStoreRef.current[pageNum] = { page, viewport, textItems, editMap: {} };

    // Create wrapper safely bypassing React for the complex canvas overlay stuff
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.id = 'page-wrapper-' + pageNum;

    const bgCanvas = document.createElement('canvas');
    bgCanvas.id = 'bg-canvas-' + pageNum;
    bgCanvas.width = viewport.width;
    bgCanvas.height = viewport.height;
    bgCanvas.style.cssText = 'display:block;position:absolute;top:0;left:0;z-index:0;';

    const bgCtx = bgCanvas.getContext('2d');
    await page.render({ canvasContext: bgCtx, viewport }).promise;
    wrapper.appendChild(bgCanvas);

    const fgCanvas = document.createElement('canvas');
    fgCanvas.id = 'fg-canvas-' + pageNum;
    fgCanvas.width = viewport.width;
    fgCanvas.height = viewport.height;
    fgCanvas.style.cssText = 'display:block;position:absolute;top:0;left:0;z-index:1;pointer-events:none;';
    wrapper.appendChild(fgCanvas);

    const spacer = document.createElement('div');
    spacer.style.cssText = `width:${viewport.width}px;height:${viewport.height}px;display:block;`;
    wrapper.appendChild(spacer);

    const hitLayer = document.createElement('div');
    hitLayer.style.cssText = `position:absolute;top:0;left:0;width:${viewport.width}px;height:${viewport.height}px;z-index:2;`;

    textItems.forEach(ti => {
      const hit = document.createElement('div');
      hit.style.cssText = `
        position:absolute;
        left:${ti.x}px;
        top:${ti.y - ti.fontHeight}px;
        width:${Math.max(ti.width, 4)}px;
        height:${ti.fontHeight + 4}px;
        cursor:text;
        transform-origin:left bottom;
        ${Math.abs(ti.angle) > 0.001 ? `transform:rotate(${ti.angle}rad);` : ''}
      `;
      hit.title = 'Click to edit';
      hit.addEventListener('click', () => openInlineEditor(pageNum, ti.idx, wrapper, viewport));
      hitLayer.appendChild(hit);
    });

    wrapper.appendChild(hitLayer);
    if (canvasAreaRef.current) canvasAreaRef.current.appendChild(wrapper);

    // Thumbnail
    const thumbWrapper = document.createElement('div');
    thumbWrapper.className = 'page-thumb' + (pageNum === 1 ? ' active' : '');
    thumbWrapper.dataset.page = String(pageNum);
    thumbWrapper.onclick = () => {
      document.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('active'));
      thumbWrapper.classList.add('active');
      wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    const thumbCanvas = document.createElement('canvas');
    const thumbVP = page.getViewport({ scale: 0.2 });
    thumbCanvas.width = thumbVP.width;
    thumbCanvas.height = thumbVP.height;
    await page.render({ canvasContext: thumbCanvas.getContext('2d'), viewport: thumbVP }).promise;
    
    const numLabel = document.createElement('div');
    numLabel.className = 'page-num';
    numLabel.style.cssText = 'position:absolute;bottom:4px;right:6px;font-family:var(--font-dm-mono);font-size:10px;color:var(--color-text-dim);background:rgba(0,0,0,0.5);padding:2px 5px;border-radius:3px;';
    numLabel.textContent = String(pageNum);
    
    thumbWrapper.appendChild(thumbCanvas);
    thumbWrapper.appendChild(numLabel);
    if (pageThumbsRef.current) pageThumbsRef.current.appendChild(thumbWrapper);
  };

  const getCSSFont = (pdfFontName: string) => {
    if (!pdfFontName) return 'Arial, sans-serif';
    const f = pdfFontName.toLowerCase();
    if (f.includes('times')) return 'Times New Roman, serif';
    if (f.includes('courier') || f.includes('mono')) return 'Courier New, monospace';
    if (f.includes('helvetica') || f.includes('arial')) return 'Helvetica, Arial, sans-serif';
    if (f.includes('georgia')) return 'Georgia, serif';
    if (f.includes('verdana')) return 'Verdana, sans-serif';
    if (f.includes('calibri')) return 'Calibri, sans-serif';
    if (f.includes('garamond')) return 'Garamond, serif';
    return 'Arial, sans-serif';
  };

  const eraseTextRegion = (ctx: CanvasRenderingContext2D, ti: any, fontSize: number) => {
    const pad = 3;
    ctx.save();
    ctx.translate(ti.x, ti.y);
    if (Math.abs(ti.angle) > 0.001) ctx.rotate(ti.angle);
    ctx.clearRect(-pad, -fontSize - pad, ti.width + pad * 2, fontSize + pad * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-pad, -fontSize - pad, ti.width + pad * 2, fontSize + pad * 2);
    ctx.restore();
  };

  const repaintPage = async (pageNum: number) => {
    const store = pageStoreRef.current[pageNum];
    if (!store) return;
    const { page, viewport, textItems, editMap } = store;

    const bgCanvas = document.getElementById('bg-canvas-' + pageNum) as HTMLCanvasElement;
    const fgCanvas = document.getElementById('fg-canvas-' + pageNum) as HTMLCanvasElement;
    if (!bgCanvas || !fgCanvas) return;

    const bgCtx = bgCanvas.getContext('2d');
    const fgCtx = fgCanvas.getContext('2d');
    if (!bgCtx || !fgCtx) return;

    bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    await page.render({ canvasContext: bgCtx, viewport }).promise;

    fgCtx.clearRect(0, 0, fgCanvas.width, fgCanvas.height);

    textItems.forEach((ti: any) => {
      const edit = editMap[ti.idx];
      if (!edit) return;

      eraseTextRegion(bgCtx, ti, ti.fontHeight);

      const fSize = edit.fontSize ?? ti.fontHeight;
      const fFamily = edit.fontFamily ?? getCSSFont(ti.fontName);
      const fWeight = edit.fontWeight ?? 'normal';
      const fStyle = edit.fontStyle ?? 'normal';
      const fColor = edit.color ?? '#000000';

      fgCtx.save();
      fgCtx.translate(ti.x, ti.y);
      if (Math.abs(ti.angle) > 0.001) fgCtx.rotate(ti.angle);
      fgCtx.font = `${fStyle} ${fWeight} ${fSize}px ${fFamily}`;
      fgCtx.fillStyle = fColor;
      fgCtx.textBaseline = 'alphabetic';
      fgCtx.fillText(edit.text, 0, 0);
      fgCtx.restore();
    });
  };

  const openInlineEditor = (pageNum: number, itemIdx: number, wrapper: HTMLElement, viewport: any) => {
    if (currentEditorRef.current) currentEditorRef.current.close(true);

    const store = pageStoreRef.current[pageNum];
    const ti = store.textItems.find((t: any) => t.idx === itemIdx);
    if (!ti) return;

    const currentText = store.editMap[itemIdx]?.text ?? ti.str;
    const currentColor = store.editMap[itemIdx]?.color ?? '#000000';
    const currentFont = store.editMap[itemIdx]?.fontFamily ?? getCSSFont(ti.fontName);
    const currentWeight = store.editMap[itemIdx]?.fontWeight ?? (/Bold/i.test(ti.fontName) ? 'bold' : 'normal');
    const currentStyle2 = store.editMap[itemIdx]?.fontStyle ?? (/Italic|Oblique/i.test(ti.fontName) ? 'italic' : 'normal');
    const currentSize = store.editMap[itemIdx]?.fontSize ?? ti.fontHeight;

    const bgCanvas = document.getElementById('bg-canvas-' + pageNum) as HTMLCanvasElement;
    if (bgCanvas) {
      const bgCtx = bgCanvas.getContext('2d');
      if (bgCtx) eraseTextRegion(bgCtx, ti, currentSize);
    }

    const textarea = document.createElement('textarea');
    textarea.value = currentText;
    textarea.rows = 1;
    textarea.spellcheck = false;
    textarea.style.cssText = `
      position: absolute;
      left: ${ti.x}px;
      top:  ${ti.y - currentSize - 2}px;
      min-width: ${Math.max(ti.width, 60)}px;
      font-size:   ${currentSize}px;
      font-family: ${currentFont};
      font-weight: ${currentWeight};
      font-style:  ${currentStyle2};
      color:       ${currentColor};
      line-height: 1;
      padding: 0;
      margin:  0;
      border:  none;
      outline: 2px solid #3b82f6;
      outline-offset: 2px;
      background: rgba(255,255,255,0.95);
      resize: none;
      overflow: hidden;
      white-space: pre;
      z-index: 20;
      caret-color: #1d4ed8;
      border-radius: 2px;
      box-sizing: content-box;
      ${Math.abs(ti.angle) > 0.001 ? `transform:rotate(${ti.angle}rad);transform-origin:left bottom;` : ''}
    `;

    textarea.addEventListener('input', () => {
      const tmp = document.createElement('span');
      tmp.style.cssText = `visibility:hidden;position:absolute;white-space:pre;font:${textarea.style.font};font-size:${textarea.style.fontSize};font-family:${textarea.style.fontFamily};font-weight:${textarea.style.fontWeight};font-style:${textarea.style.fontStyle};`;
      tmp.textContent = textarea.value || ' ';
      document.body.appendChild(tmp);
      textarea.style.width = (tmp.offsetWidth + 10) + 'px';
      document.body.removeChild(tmp);
      setEditsMade(true);
    });

    wrapper.appendChild(textarea);
    textarea.focus();
    textarea.select();

    activeTextBlockRef.current = textarea;
    setToolbarValues({
      fontFamily: currentFont,
      fontSize: Math.round(currentSize).toString(),
      color: currentColor,
    });

    const close = (commit: boolean) => {
      if (!wrapper.contains(textarea)) return;
      const newText = textarea.value;
      const fSize = parseFloat(textarea.style.fontSize);
      const fFamily = textarea.style.fontFamily;
      const fWeight = textarea.style.fontWeight;
      const fStyle = textarea.style.fontStyle;
      const fColor = textarea.style.color;

      if (commit) {
        store.editMap[itemIdx] = {
          text: newText, color: fColor,
          fontFamily: fFamily, fontWeight: fWeight,
          fontStyle: fStyle, fontSize: fSize
        };
      }

      wrapper.removeChild(textarea);
      currentEditorRef.current = null;
      activeTextBlockRef.current = null;

      repaintPage(pageNum);
    };

    textarea.addEventListener('blur', () => setTimeout(() => close(true), 80));
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Escape') close(false);
    });

    currentEditorRef.current = { close, textarea, pageNum, itemIdx };
  };

  const applyStyle = (prop: string, value: string) => {
    if (!activeTextBlockRef.current) return;
    const ta = activeTextBlockRef.current;
    
    if (prop === 'fontSize') { ta.style.fontSize = value; setToolbarValues(p => ({...p, fontSize: value.replace('px', '')})); }
    if (prop === 'fontFamily') { ta.style.fontFamily = value; setToolbarValues(p => ({...p, fontFamily: value})); }
    if (prop === 'fontWeight') { ta.style.fontWeight = value; }
    if (prop === 'fontStyle') { ta.style.fontStyle = value; }
    if (prop === 'color') { ta.style.color = value; setToolbarValues(p => ({...p, color: value})); }
    if (prop === 'textAlign') { ta.style.textAlign = value; }
    
    setEditsMade(true);
  };

  const applyFormat = (cmd: string) => {
    if (!activeTextBlockRef.current) return;
    const ta = activeTextBlockRef.current;
    if (cmd === 'bold') ta.style.fontWeight = ta.style.fontWeight === 'bold' ? 'normal' : 'bold';
    if (cmd === 'italic') ta.style.fontStyle = ta.style.fontStyle === 'italic' ? 'normal' : 'italic';
    if (cmd === 'underline') ta.style.textDecoration = ta.style.textDecoration === 'underline' ? 'none' : 'underline';
    if (cmd === 'strikethrough') ta.style.textDecoration = ta.style.textDecoration === 'line-through' ? 'none' : 'line-through';
    setEditsMade(true);
  };

  const askGemini = async () => {
    if (!activeTextBlockRef.current) { showToast('Pehle kisi text par click karo, phir Gemini use karo', 'error'); return; }
    if (!geminiPrompt.trim()) { showToast('Gemini ke liye prompt likho', 'error'); return; }

    const selectedText = activeTextBlockRef.current.value || '';
    setIsLoading(true);
    setLoadingText('ASKING GEMINI...');

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is missing.");
      
      const ai = new GoogleGenAI({ apiKey });
      const fullPrompt = `You are editing text in a PDF document. The selected text is:\n\n"${selectedText}"\n\nUser instruction: ${geminiPrompt}\n\nRespond ONLY with the improved/modified text, nothing else. No explanations, no quotes around the text.`;
      
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: fullPrompt
      });
      
      const newText = response.text;
      
      if (newText) {
        activeTextBlockRef.current.value = newText;
        activeTextBlockRef.current.dispatchEvent(new Event('input'));
        showToast('Gemini ne text update kar diya!', 'success');
      } else {
        throw new Error('No response from Gemini');
      }
    } catch (err: any) {
      showToast('Gemini error: ' + err.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const downloadEdited = () => {
    if (!pdfDoc) return showToast('Pehle PDF load karo', 'error');

    const printWin = window.open('', '_blank');
    if (!printWin) return showToast('Popup blocked', 'error');

    let html = `<html><head><style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body { background:#888; }
      .page { display:block; page-break-after:always; margin:0 auto 20px; position:relative; }
      canvas { display:block; }
    </style></head><body>`;

    const wrappers = canvasAreaRef.current?.querySelectorAll('.pdf-page-wrapper');
    wrappers?.forEach(wrapper => {
      const bgCanvas = wrapper.querySelector('canvas[id^="bg-canvas"]') as HTMLCanvasElement;
      const fgCanvas = wrapper.querySelector('canvas[id^="fg-canvas"]') as HTMLCanvasElement;
      if (!bgCanvas) return;

      const tmp = document.createElement('canvas');
      tmp.width = bgCanvas.width;
      tmp.height = bgCanvas.height;
      const tCtx = tmp.getContext('2d');
      if (tCtx) {
        tCtx.drawImage(bgCanvas, 0, 0);
        if (fgCanvas) tCtx.drawImage(fgCanvas, 0, 0);
      }

      html += `<div class="page" style="width:${tmp.width}px;height:${tmp.height}px;">`;
      html += `<img src="${tmp.toDataURL('image/png')}" style="width:${tmp.width}px;height:${tmp.height}px;">`;
      html += `</div>`;
    });

    html += `</body></html>`;
    printWin.document.write(html);
    printWin.document.close();
    setTimeout(() => {
      printWin.print();
      showToast('Print dialog mein "Save as PDF" choose karo', 'success');
    }, 600);
  };

  const resetEditor = () => {
    setPdfDoc(null);
    setEditsMade(false);
    setIsLoaded(false);
    currentEditorRef.current = null;
    activeTextBlockRef.current = null;
    pageStoreRef.current = {};
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="min-h-screen text-slate-100 w-full relative overflow-x-hidden flex flex-col" style={{ backgroundColor: '#0f172a', backgroundImage: 'radial-gradient(at 0% 0%, #1e1b4b 0%, transparent 50%), radial-gradient(at 100% 0%, #312e81 0%, transparent 50%), radial-gradient(at 100% 100%, #1e1b4b 0%, transparent 50%), radial-gradient(at 0% 100%, #4338ca 0%, transparent 50%)' }}>
      {/* HEADER */}
      <header className="sticky top-0 z-[100] flex items-center justify-between px-6 h-16 border-b border-white/10 bg-white/5 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center font-bold text-lg shadow-[0_0_15px_rgba(99,102,241,0.5)]">P</div>
          <h1 className="text-xl font-bold tracking-tight text-white">PDFly<span className="text-indigo-400">.</span></h1>
        </div>
        <nav className="flex items-center gap-6">
          <div className="flex bg-white/5 p-1 rounded-full border border-white/10 hidden md:flex">
            <button className="px-4 py-1.5 text-xs font-medium rounded-full bg-white/10 text-white border border-transparent shadow-sm hover:bg-white/20 transition-all" onClick={() => document.getElementById('featuresSection')?.scrollIntoView({ behavior: 'smooth' })}>Tools</button>
            <button className="px-4 py-1.5 text-xs font-medium rounded-full text-slate-400 hover:text-white hover:bg-white/5 transition-all" onClick={() => showToast('Free plan available!', 'success')}>Pricing</button>
          </div>
          <div className="h-8 w-px bg-white/10 hidden md:block"></div>
          <button className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-5 py-2 rounded-lg shadow-lg transition-all" onClick={() => fileInputRef.current?.click()}>Open PDF</button>
        </nav>
      </header>

      {/* Conditional Rendering of Editor vs Landing */}
      {!isLoaded ? (
        <>
          <section className="relative z-10 text-center pt-20 pb-16 px-8">
            <div className="inline-flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/30 rounded-full px-4 py-1.5 text-xs font-[var(--font-dm-mono)] text-[var(--color-accent)] mb-8 tracking-wide">
              <div className="w-1.5 h-1.5 bg-[var(--color-accent3)] rounded-full animate-pulse"></div>
              ✦ AI-Powered PDF Editor
            </div>
            <h1 className="font-[var(--font-syne)] text-4xl sm:text-5xl md:text-6xl font-extrabold leading-tight tracking-tighter mb-5">
              Edit PDFs like a<br />
              <span className="bg-gradient-to-br from-indigo-500 via-pink-500 to-emerald-400 bg-clip-text text-transparent">text document</span>
            </h1>
            <p className="text-lg text-[var(--color-text-muted)] max-w-xl mx-auto mb-12 leading-relaxed font-light font-[var(--font-dm-sans)]">
              Upload any PDF and edit the original text directly. Powered by Google Gemini for intelligent AI assistance.
            </p>

            <div className="flex justify-center gap-2 px-8 pb-10 flex-wrap relative z-10">
              {['edit', 'merge', 'split', 'compress', 'convert', 'sign'].map(tab => (
                <button
                  key={tab}
                  className={cn(
                    "font-[var(--font-dm-sans)] text-[13px] font-medium px-5 py-2.5 rounded-full border flex items-center gap-2 transition-all",
                    activeTab === tab 
                      ? "bg-white/10 border-indigo-400/50 text-white shadow-[0_0_10px_rgba(99,102,241,0.2)]" 
                      : "border-white/10 bg-white/5 backdrop-blur-sm text-slate-400 hover:text-white hover:bg-white/10"
                  )}
                  onClick={() => {
                    setActiveTab(tab);
                    if (tab !== 'edit') showToast('Coming soon — focus is on text editing for now!');
                  }}
                >
                  <span className="text-[15px]">
                    {tab === 'edit' && '✏️'}
                    {tab === 'merge' && '🔗'}
                    {tab === 'split' && '✂️'}
                    {tab === 'compress' && '🗜️'}
                    {tab === 'convert' && '🔄'}
                    {tab === 'sign' && '✍️'}
                  </span>
                  <span className="capitalize">{tab} {tab === 'edit' && 'Text'}</span>
                </button>
              ))}
            </div>

            <div className="max-w-5xl mx-auto px-6 pb-20 relative z-10">
              <div className="bg-slate-900/40 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden shadow-2xl relative">
                
                {isLoading && (
                  <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center gap-4 rounded-2xl">
                    <div className="w-10 h-10 border-4 border-white/10 border-t-indigo-500 rounded-full animate-spin"></div>
                    <div className="font-[var(--font-dm-mono)] text-xs text-slate-400 tracking-widest">{loadingText}</div>
                  </div>
                )}

                <div 
                  className={cn("flex flex-col items-center justify-center border-2 border-dashed border-indigo-500/30 m-6 rounded-2xl cursor-pointer transition-all p-20 hover:border-indigo-400/50 hover:bg-indigo-500/10")}
                  onDrop={handleDrop}
                  onDragOver={(e) => e.preventDefault()}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className="w-20 h-20 bg-gradient-to-br from-indigo-500/20 to-indigo-600/20 rounded-2xl flex items-center justify-center text-4xl mb-6 border border-indigo-500/20 shadow-[0_0_15px_rgba(99,102,241,0.2)]">📄</div>
                  <h3 className="text-2xl font-bold mb-2 tracking-tight text-white">Drop your PDF here</h3>
                  <p className="text-slate-400 text-sm mb-6 text-center">Drag & drop or click to browse<br/>Supports PDF files up to 100MB</p>
                  <button className="font-semibold text-sm px-7 py-3 rounded-lg bg-indigo-600 text-white shadow-lg hover:bg-indigo-500 transition-all" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click() }}>
                    Choose PDF File
                  </button>
                  <input type="file" ref={fileInputRef} accept=".pdf" className="hidden" onChange={handleFileSelect} />
                </div>
              </div>
            </div>

            <section id="featuresSection" className="max-w-5xl mx-auto mt-10">
              <h2 className="text-4xl font-bold text-center mb-4 tracking-tighter text-white">Everything you need</h2>
              <p className="text-center text-slate-400 mb-14 text-lg font-light">30+ tools to handle any PDF task</p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 border-t border-white/5 pt-10">
                {[
                  { icon: '✏️', colorClass: 'bg-indigo-500/20 text-indigo-400', title: 'Edit Original Text', text: 'Click any text in your PDF and edit it directly. Change font, size, color, and style instantly.' },
                  { icon: '✨', colorClass: 'bg-emerald-500/20 text-emerald-400', title: 'AI Text Improvement', text: 'Use Google Gemini to rewrite, translate, summarize, or improve selected text in seconds.' },
                  { icon: '🔗', colorClass: 'bg-pink-500/20 text-pink-400', title: 'Merge PDFs', text: 'Combine multiple PDF files into one. Drag to reorder, select specific pages from each file.' },
                  { icon: '✂️', colorClass: 'bg-amber-500/20 text-amber-400', title: 'Split & Extract', text: 'Split by page range, file size, or outline. Extract specific pages into separate files.' },
                  { icon: '🗜️', colorClass: 'bg-cyan-500/20 text-cyan-400', title: 'Compress PDF', text: 'Reduce file size dramatically while maintaining quality. Perfect for email and web.' },
                  { icon: '🔒', colorClass: 'bg-fuchsia-500/20 text-fuchsia-400', title: 'Secure & Private', text: 'Files are processed locally in your browser. Nothing is uploaded to external servers.' },
                ].map(f => (
                  <div key={f.title} className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-7 transition-all hover:-translate-y-1 hover:shadow-2xl hover:border-indigo-500/30 hover:bg-white/10 text-left group">
                    <div className={cn("w-12 h-12 rounded-xl border border-white/5 flex items-center justify-center text-[22px] mb-5 shadow-inner", f.colorClass)}>{f.icon}</div>
                    <h4 className="text-[16px] font-bold mb-2 tracking-tight text-white">{f.title}</h4>
                    <p className="text-[13px] text-slate-400 leading-relaxed font-light">{f.text}</p>
                  </div>
                ))}
              </div>
            </section>
          </section>
        </>
      ) : (
        <div className="flex-1 flex overflow-hidden relative">
            
            {isLoading && (
              <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-md z-50 flex flex-col items-center justify-center gap-4">
                <div className="w-10 h-10 border-4 border-white/10 border-t-indigo-500 rounded-full animate-spin"></div>
                <div className="font-mono text-xs text-slate-400 tracking-widest">{loadingText}</div>
              </div>
            )}

            <aside className="w-48 bg-white/5 backdrop-blur-sm border-r border-white/10 p-4 flex flex-col gap-4 overflow-y-auto flex-shrink-0 hidden md:flex">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold px-2">Pages</div>
              <div ref={pageThumbsRef} className="space-y-4"></div>
            </aside>

            <main className="flex-1 relative bg-slate-900/50 flex flex-col overflow-hidden">
              <div className="h-12 bg-white/5 backdrop-blur-md border-b border-white/10 flex items-center px-4 gap-2 flex-wrap shrink-0">
                <select className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none" value={toolbarValues.fontFamily} onChange={e => applyStyle('fontFamily', e.target.value)}>
                  <option value="Arial">Arial</option>
                  <option value="Times New Roman">Times New Roman</option>
                  <option value="Courier New">Courier New</option>
                  <option value="Georgia">Georgia</option>
                  <option value="Verdana">Verdana</option>
                  <option value="Helvetica">Helvetica</option>
                </select>
                <select className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none" value={toolbarValues.fontSize} onChange={e => applyStyle('fontSize', e.target.value + 'px')}>
                  {[8, 10, 12, 14, 16, 18, 24, 32, 48].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <div className="flex gap-1 ml-2">
                  <button className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 text-slate-300 transition-colors" title="Bold" onClick={() => applyFormat('bold')}><b>B</b></button>
                  <button className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 text-slate-300 font-serif transition-colors" title="Italic" onClick={() => applyFormat('italic')}><i>I</i></button>
                  <button className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 text-slate-300 underline transition-colors" title="Underline" onClick={() => applyFormat('underline')}><u>U</u></button>
                  <button className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 text-slate-300 transition-colors" title="Strikethrough" onClick={() => applyFormat('strikethrough')}><s>S</s></button>
                </div>
                <div className="h-4 w-px bg-white/10 mx-2"></div>
                <div className="flex gap-1">
                  <button className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 text-slate-300" onClick={() => applyStyle('textAlign', 'left')}>⬅</button>
                  <button className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 text-slate-300" onClick={() => applyStyle('textAlign', 'center')}>↔</button>
                  <button className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 text-slate-300" onClick={() => applyStyle('textAlign', 'right')}>➡</button>
                </div>
                <div className="flex items-center gap-1.5 ml-2">
                  <input type="color" className="w-6 h-6 rounded bg-transparent border border-white/10 p-0.5 cursor-pointer block" value={toolbarValues.color} title="Text Color" onChange={e => applyStyle('color', e.target.value)} />
                  <input type="color" className="w-6 h-6 rounded bg-transparent border border-white/10 p-0.5 cursor-pointer block" defaultValue="#ffff00" title="Highlight Box" onChange={e => applyStyle('backgroundColor', e.target.value)} />
                </div>
              </div>

              <div id="canvasArea" ref={canvasAreaRef} className="flex-1 p-8 overflow-y-auto flex flex-col items-center gap-6"></div>

              <footer className="h-8 bg-black/40 backdrop-blur-md border-t border-white/5 px-4 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-4 text-[10px] font-mono text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-green-500"></span>
                    Ready
                  </span>
                  <span>|</span>
                  <span>{fileName}</span>
                  <span>|</span>
                  <span>{totalPages} page(s)</span>
                </div>
                <div className="flex items-center gap-4 text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
                  {fileSize} <span className="opacity-50">|</span> <span className="text-indigo-400">{editsMade ? '● Unsaved edits' : ''}</span>
                </div>
              </footer>
            </main>

            <aside className="w-72 bg-white/5 backdrop-blur-md border-l border-white/10 p-5 flex flex-col gap-6 flex-shrink-0 overflow-y-auto hidden lg:flex">
              <div className="flex items-center gap-2 text-indigo-300">
                <span className="text-lg">✨</span>
                <h4 className="text-sm font-bold uppercase tracking-widest">AI Assistant</h4>
              </div>

              <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-4">
                  <textarea 
                    className="w-full bg-black/20 border border-white/5 rounded-lg p-2.5 text-xs text-slate-200 resize-none h-[80px] outline-none focus:border-indigo-500 mb-2 transition-colors placeholder:text-slate-500" 
                    placeholder="e.g. Improve this paragraph, translate to Urdu..."
                    value={geminiPrompt}
                    onChange={e => setGeminiPrompt(e.target.value)}
                  />
                  <button 
                    className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all shadow-lg flex justify-center items-center gap-1.5"
                    onClick={askGemini}
                  >
                    ✦ Ask Gemini
                  </button>
                  <p className="text-[10px] text-indigo-200/50 mt-2 text-center">Powered by Free Gemini Model</p>
              </div>

              <div className="space-y-4">
                <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-2">Editor Tools</span>
                <button className="w-full py-2.5 bg-white/5 border border-white/10 hover:bg-white/10 text-left px-4 rounded-lg text-xs flex justify-between items-center group transition-colors" onClick={downloadEdited}>
                  <span className="text-slate-300 group-hover:text-white font-medium">Download PDF</span>
                  <span className="text-slate-500 group-hover:text-indigo-400">↓</span>
                </button>
                <button className="w-full py-2.5 bg-white/5 border border-white/10 hover:bg-white/10 text-left px-4 rounded-lg text-xs flex justify-between items-center group transition-colors" onClick={() => showToast('Click on any text in the PDF to edit it', 'info')}>
                  <span className="text-slate-300 group-hover:text-white font-medium">Edit Text Block</span>
                  <span className="text-slate-500 group-hover:text-indigo-400">+</span>
                </button>
                <button className="w-full py-2.5 bg-white/5 border border-white/10 hover:bg-white/10 text-left px-4 rounded-lg text-xs flex justify-between items-center group transition-colors" onClick={resetEditor}>
                  <span className="text-slate-300 group-hover:text-white font-medium">Load New PDF</span>
                  <span className="text-slate-500 group-hover:text-indigo-400">↺</span>
                </button>
              </div>

            </aside>
        </div>
      )}

      {/* TOAST */}
      <div className={cn(
        "fixed bottom-8 right-8 bg-black/60 backdrop-blur-md border rounded-xl px-5 py-3.5 text-[13px] z-[1000] flex items-center gap-3 transition-all duration-300 shadow-xl shadow-black/50 font-[var(--font-dm-sans)] font-medium text-white",
        toast.show ? "translate-y-0 opacity-100" : "translate-y-10 opacity-0 pointer-events-none",
        toast.type === 'success' ? "border-emerald-500/40" : toast.type === 'error' ? "border-pink-500/40" : "border-white/10"
      )}>
        <span>{toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : 'ℹ'}</span>
        <span>{toast.msg}</span>
      </div>
      
    </div>
  );
}
