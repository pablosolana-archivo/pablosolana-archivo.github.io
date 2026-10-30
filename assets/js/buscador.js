/*
  BUSCADOR DEL BLOG
  -----------------
  Busca en el texto completo de todas las notas, sin servicios externos.

  De donde saca las notas: del archivo feed.json que Publii genera en cada
  publicacion. Para que esten todas, en Publii (Configuracion del sitio >
  Avanzado > Feed) el numero de entradas del feed tiene que ser mayor que la
  cantidad de notas (esta en 1000).

  Como funciona:
  - El formulario de la columna lateral manda a la portada con ?q=palabras.
  - Al abrir cualquier pagina con ?q=..., este archivo baja feed.json (una sola
    vez: despues queda en la memoria del navegador) y reemplaza la columna
    central por los resultados.
  - No distingue mayusculas ni tildes. Tienen que estar todas las palabras.
    Una frase entre comillas se busca exacta. Cada palabra se busca como
    comienzo de palabra: "piquet" encuentra "piqueteros", "paz" no encuentra
    "capaz".
  - Orden: arriba de los resultados hay un selector (mas relevantes, mas
    recientes, mas antiguas, titulo A-Z). El elegido queda en la direccion
    (&orden=...) y el navegador lo recuerda para la proxima busqueda.
    "Mas relevantes" suma puntos por: estar en el titulo (mucho), las palabras
    juntas como frase, y cuantas veces aparecen en el texto (con tope, para
    que las notas largas no ganen solo por largas). Empate: la mas nueva.
  - Arriba muestra las etiquetas de la columna lateral que coinciden.

  Lo que se puede cambiar sin riesgo: los textos entre comillas de MENSAJES y
  de ORDENES, y el numero POR_PAGINA. El color del resaltado esta en main.css (buscar
  "BUSCADOR").
*/
(function () {
  'use strict';

  var POR_PAGINA = 20;
  var MENSAJES = {
    cargando: 'Buscando…',
    titulo: function (q, n) {
      return 'Búsqueda: «' + q + '» — ' + n + (n === 1 ? ' nota' : ' notas');
    },
    nada: function (q) {
      return 'No hay notas que contengan «' + q + '». Probá con menos palabras o con otra forma de escribirlas.';
    },
    corta: 'Escribí al menos dos letras.',
    error: 'No se pudo cargar el índice de búsqueda. Revisá la conexión y probá de nuevo.',
    etiquetas: 'Etiquetas que coinciden:',
    masNotas: 'Mostrar más notas',
    volver: '« Volver a la portada'
  };

  // Opciones del selector de orden: [valor en la direccion, texto que se ve].
  var ORDENES = [
    ['relevancia', 'Más relevantes'],
    ['recientes', 'Más recientes'],
    ['antiguas', 'Más antiguas'],
    ['titulo', 'Título (A–Z)']
  ];
  var ETIQUETA_ORDEN = 'Ordenar por';

  var form = document.querySelector('form.buscador-form');
  if (!form) return;
  var input = form.querySelector('input[name="q"]');
  var raiz = form.getAttribute('action');
  var urlFeed = form.getAttribute('data-feed');

  // ---------- direccion y orden ----------
  function leerParam(nombre) {
    var m = new RegExp('[?&]' + nombre + '=([^&#]*)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() : '';
  }
  function leerQ() { return leerParam('q'); }
  function ordenValido(o) { return ORDENES.some(function (x) { return x[0] === o; }); }
  function ordenGuardado() {
    try { var o = localStorage.getItem('buscador-orden'); return ordenValido(o) ? o : ''; }
    catch (e) { return ''; }
  }
  function guardarOrden(o) { try { localStorage.setItem('buscador-orden', o); } catch (e) {} }
  function ordenDeLaDireccion() {
    var o = leerParam('orden');
    return ordenValido(o) ? o : (ordenGuardado() || 'relevancia');
  }
  function direccion(q, orden) {
    return raiz + '?q=' + encodeURIComponent(q) + (orden && orden !== 'relevancia' ? '&orden=' + orden : '');
  }

  // Al enviar: si ya estamos en la portada, se busca ahi mismo.
  form.addEventListener('submit', function (ev) {
    var q = (input.value || '').trim();
    if (!q) { ev.preventDefault(); return; }
    var orden = ordenGuardado() || 'relevancia';
    var aca = location.origin + location.pathname;
    ev.preventDefault();
    if (aca === raiz || aca + '/' === raiz) {
      history.pushState({ q: q }, '', direccion(q, orden));
      buscar(q, orden);
    } else {
      location.href = direccion(q, orden);
    }
  });
  window.addEventListener('popstate', function () {
    var q = leerQ();
    if (q) buscar(q, ordenDeLaDireccion()); else location.reload();
  });

  // ---------- texto ----------
  function normalizar(s) {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function escapar(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escaparRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // Se usa <template> porque su contenido es inerte: el navegador no baja las
  // imagenes de las notas al leer el texto.
  function textoPlano(html) {
    var t = document.createElement('template');
    t.innerHTML = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
                      .replace(/<(br|\/p|\/div|\/h\d|\/li|\/blockquote)[^>]*>/gi, ' $& ');
    return (t.content.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function partirConsulta(q) {
    var piezas = [], re = /"([^"]+)"|(\S+)/g, m;
    while ((m = re.exec(q))) {
      var t = normalizar((m[1] || m[2]).trim());
      if (t.length >= 2) piezas.push(t);
    }
    return piezas;
  }
  // Cada pieza tiene que aparecer al comienzo de una palabra.
  // Con "entera", la marca se extiende hasta el final de la palabra.
  function regexDe(pieza, entera) {
    return new RegExp('(^|[^a-z0-9])(' + escaparRegex(pieza).replace(/\s+/g, '\\s+') +
                      (entera ? '[a-z0-9]*' : '') + ')', 'g');
  }

  // ---------- indice ----------
  var notas = null, cargandoIndice = null;
  function cargarIndice() {
    if (notas) return Promise.resolve(notas);
    if (cargandoIndice) return cargandoIndice;
    cargandoIndice = fetch(urlFeed).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (feed) {
      notas = (feed.items || []).map(function (it) {
        var texto = textoPlano(it.content_html || it.summary || '');
        return {
          url: it.url,
          titulo: it.title || '',
          tituloN: normalizar(it.title || ''),
          texto: texto,
          textoN: normalizar(texto),
          fecha: it.date_published ? new Date(it.date_published) : null
        };
      });
      return notas;
    });
    cargandoIndice.catch(function () { cargandoIndice = null; });
    return cargandoIndice;
  }

  // ---------- relevancia ----------
  function contar(re, texto, tope) {
    var c = 0; re.lastIndex = 0;
    while (c < tope && re.exec(texto)) c++;
    return c;
  }
  function puntaje(n, piezas) {
    var p = 0;
    piezas.forEach(function (pz) {
      if (regexDe(pz).test(n.tituloN)) p += 30;
      p += 4 * Math.sqrt(contar(regexDe(pz), n.textoN, 40));
    });
    if (piezas.length > 1) {
      var frase = regexDe(piezas.join(' '));
      if (frase.test(n.tituloN)) p += 40;
      else if (contar(frase, n.textoN, 1)) p += 15;
    }
    return p;
  }
  var cotejo = new Intl.Collator('es', { sensitivity: 'base', ignorePunctuation: true });
  function ordenar(res, orden) {
    var porFecha = function (a, b) { return (b.n.fecha || 0) - (a.n.fecha || 0); };
    var f = {
      relevancia: function (a, b) { return (b.p - a.p) || porFecha(a, b); },
      recientes: porFecha,
      antiguas: function (a, b) { return -porFecha(a, b); },
      titulo: function (a, b) { return cotejo.compare(a.n.titulo, b.n.titulo); }
    }[orden] || porFecha;
    return res.slice().sort(f);
  }

  // ---------- presentacion ----------
  var formatoFecha = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric' });

  function fragmento(nota, piezas) {
    var t = nota.texto, tn = nota.textoN, inicio = 0;
    if (tn.length === t.length) {
      for (var i = 0; i < piezas.length; i++) {
        var re = regexDe(piezas[i]); re.lastIndex = 0;
        var m = re.exec(tn);
        if (m) { inicio = m.index + m[1].length; break; }
      }
    }
    var desde = Math.max(0, inicio - 110), hasta = Math.min(t.length, inicio + 230);
    if (desde > 0) { var esp = t.indexOf(' ', desde); if (esp > -1 && esp < inicio) desde = esp + 1; }
    if (hasta < t.length) { var esp2 = t.lastIndexOf(' ', hasta); if (esp2 > inicio) hasta = esp2; }
    var trozo = t.slice(desde, hasta), trozoN = tn.slice(desde, hasta);
    var html = resaltar(trozo, trozoN, piezas);
    return (desde > 0 ? '… ' : '') + html + (hasta < t.length ? ' …' : '');
  }
  function resaltar(orig, norm, piezas) {
    if (orig.length !== norm.length) return escapar(orig);
    var marcas = [];
    piezas.forEach(function (p) {
      var re = regexDe(p, true), m;
      while ((m = re.exec(norm))) {
        var a = m.index + m[1].length;
        marcas.push([a, a + m[2].length]);
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    });
    marcas.sort(function (x, y) { return x[0] - y[0]; });
    var out = '', pos = 0;
    marcas.forEach(function (mk) {
      if (mk[0] < pos) return;
      out += escapar(orig.slice(pos, mk[0])) + '<mark>' + escapar(orig.slice(mk[0], mk[1])) + '</mark>';
      pos = mk[1];
    });
    return out + escapar(orig.slice(pos));
  }

  function etiquetasQueCoinciden(piezas) {
    var vistas = {}, out = [];
    document.querySelectorAll('.cloud-label-widget-content .label-size').forEach(function (s) {
      var a = s.querySelector('a'); if (!a || vistas[a.href]) return;
      var nombre = normalizar(a.textContent);
      var ok = piezas.every(function (p) { return regexDe(p).test(nombre); });
      if (ok) {
        vistas[a.href] = 1;
        var n = s.querySelector('.label-count');
        out.push('<a href="' + escapar(a.href) + '">' + escapar(a.textContent) + '</a>' +
                 (n ? ' ' + escapar(n.textContent) : ''));
      }
    });
    return out;
  }

  var columna = document.querySelector('#Blog1');
  var original = null;

  function pintar(html) {
    if (!columna) return;
    if (original === null) original = columna.innerHTML;
    columna.innerHTML = '<div class="blog-posts hfeed buscador-resultados">' + html + '</div>';
    window.scrollTo(0, 0);
  }

  function buscar(q, orden) {
    if (!ordenValido(orden)) orden = 'relevancia';
    input.value = q;
    document.title = 'Búsqueda: ' + q;
    var piezas = partirConsulta(q);
    if (!piezas.length) { pintar('<p class="buscador-aviso">' + MENSAJES.corta + '</p>'); return; }
    pintar('<p class="buscador-aviso">' + MENSAJES.cargando + '</p>');

    cargarIndice().then(function (lista) {
      var res = lista.filter(function (n) {
        return piezas.every(function (p) {
          return regexDe(p).test(n.tituloN) || regexDe(p).test(n.textoN);
        });
      }).map(function (n) { return { n: n, p: puntaje(n, piezas) }; });

      var cabeza = '<h2 class="date-header buscador-titulo"><span>' + escapar(MENSAJES.titulo(q, res.length)) + '</span></h2>';
      var etiq = etiquetasQueCoinciden(piezas);
      if (etiq.length) cabeza += '<p class="buscador-etiquetas">' + MENSAJES.etiquetas + ' ' + etiq.join(' · ') + '</p>';
      if (!res.length) {
        pintar(cabeza + '<p class="buscador-aviso">' + escapar(MENSAJES.nada(q)) + '</p>' + volver());
        return;
      }
      var selector = '<p class="buscador-orden"><label>' + ETIQUETA_ORDEN + ' <select>' +
        ORDENES.map(function (o) {
          return '<option value="' + o[0] + '"' + (o[0] === orden ? ' selected' : '') + '>' + escapar(o[1]) + '</option>';
        }).join('') + '</select></label></p>';
      pintar(cabeza + selector + '<div class="buscador-lista"></div><div class="buscador-mas"></div>' + volver());

      var lista2 = columna.querySelector('.buscador-lista'), mas = columna.querySelector('.buscador-mas');
      var ordenados, mostradas;
      function tanda() {
        var html = '';
        ordenados.slice(mostradas, mostradas + POR_PAGINA).forEach(function (r) {
          var n = r.n;
          html += '<div class="date-outer">' +
            (n.fecha ? '<h2 class="date-header"><span>' + escapar(formatoFecha.format(n.fecha)) + '</span></h2>' : '') +
            '<div class="date-posts"><div class="post-outer"><div class="post hentry">' +
            '<h3 class="post-title entry-title"><a href="' + escapar(n.url) + '">' + resaltar(n.titulo, n.tituloN, piezas) + '</a></h3>' +
            '<div class="post-body entry-content"><p>' + fragmento(n, piezas) + '</p></div>' +
            '<div class="jump-link"><a href="' + escapar(n.url) + '">Leer nota completa &raquo;</a></div>' +
            '</div></div></div></div>';
        });
        lista2.insertAdjacentHTML('beforeend', html);
        mostradas += POR_PAGINA;
        mas.innerHTML = mostradas < ordenados.length
          ? '<button type="button" class="buscador-boton">' + MENSAJES.masNotas + ' (' + (ordenados.length - mostradas) + ')</button>'
          : '';
        var b = mas.querySelector('button'); if (b) b.addEventListener('click', tanda);
      }
      function mostrar(o) {
        ordenados = ordenar(res, o); mostradas = 0; lista2.innerHTML = '';
        tanda();
      }
      columna.querySelector('.buscador-orden select').addEventListener('change', function () {
        orden = this.value;
        guardarOrden(orden);
        history.replaceState({ q: q }, '', direccion(q, orden));
        mostrar(orden);
      });
      mostrar(orden);
    }).catch(function () {
      pintar('<p class="buscador-aviso">' + MENSAJES.error + '</p>' + volver());
    });
  }
  function volver() {
    return '<p class="buscador-volver"><a href="' + escapar(raiz) + '">' + MENSAJES.volver + '</a></p>';
  }

  var q0 = leerQ();
  if (q0) buscar(q0, ordenDeLaDireccion());
})();
