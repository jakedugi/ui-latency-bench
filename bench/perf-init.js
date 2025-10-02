(function() {
  if (typeof window === "undefined") return;

  if (!window.__perf) window.__perf = { enabled: true, samples: [] };

  function event(metric, value, meta) {
    window.__perf.samples.push({ metric, value, meta, ts: Date.now() });
  }
  function mark(name) {
    performance.mark(name);
  }
  function measure(metric, start, end, meta) {
    const m = performance.measure(metric, start, end);
    event(metric, m.duration, meta);
    return m.duration;
  }

  async function fetchWithPerf(input, init, label) {
    try {
      const url = typeof input === "string" ? input : input?.url ?? "";
      console.log(`[PERF] Intercepted fetch to: ${url}`);
      
      mark(`${label}:submit`);
      const t0 = performance.now();
      const res = await window.__origFetch(input, init);
      mark(`${label}:first-byte`);
      const ttfb = performance.now() - t0;
      event(`${label}:ttfb_ms`, ttfb);
      console.log(`[PERF] TTFB for ${url}: ${ttfb}ms`);

      if (!res.body || typeof res.body.getReader !== "function") {
        // Non-streaming
        mark(`${label}:last-byte`);
        measure(`${label}:ttl_ms`, `${label}:submit`, `${label}:last-byte`);
        requestAnimationFrame(() => {
          mark(`${label}:render`);
          measure(`${label}:render_ms`, `${label}:last-byte`, `${label}:render`);
        });
        return res;
      }

      const reader = res.body.getReader();
      let first = true;
      let bytes = 0;

      const stream = new ReadableStream({
        start(controller) {
          const pump = () =>
            reader.read().then(({ done, value }) => {
              if (done) {
                controller.close();
                mark(`${label}:last-byte`);
                measure(`${label}:ttl_ms`, `${label}:submit`, `${label}:last-byte`);
                requestAnimationFrame(() => {
                  mark(`${label}:render`);
                  measure(`${label}:render_ms`, `${label}:last-byte`, `${label}:render`);
                  event(`${label}:bytes_total`, bytes);
                });
                return;
              }
              if (value) {
                bytes += value.byteLength;
                if (first) {
                  first = false;
                  mark(`${label}:first-token`);
                  measure(`${label}:ttft_ms`, `${label}:submit`, `${label}:first-token`);
                }
                controller.enqueue(value);
              }
              return pump();
            });
          return pump();
        }
      });

      return new Response(stream, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
      });
    } catch (e) {
      event(`${label}:error`, 1, { message: String(e) });
      throw e;
    }
  }

  window.__origFetch = window.fetch.bind(window);
  // Playwright sets window.__perfConfig via addInitScript(config)
  window.__installFetchPerf = (regexString) => {
    const re = new RegExp(regexString);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input?.url ?? "";
      if (re.test(url)) return fetchWithPerf(input, init, "chat");
      return window.__origFetch(input, init);
    };
  };
})();
