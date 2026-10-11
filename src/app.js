// RYVO: tela e cola. A lógica está em anfitriao.js / convidado.js / tela.js / voz.js / puro.js.
// Tudo que vem da rede entra na página por textContent; nada vira HTML.
import { MSG, TETO, corAvatar, idFixo, limpaNome, textoPedido, urlPedido } from './puro.js';
import { ADMIN_WA, preparaCert, temCert, certSeExiste, sairDoGrupo, salasConhecidas, gravaSalas } from './identidade.js';
import { ligaPresenca } from './presenca.js';
import { abreSala } from './anfitriao.js';
import { entra } from './convidado.js';

// O GitHub Pages não deixa mandar frame-ancestors: sem isto, outro site poderia embutir a página e
// induzir alguém a digitar o código dentro dele.
if (window.top !== window.self) {
  document.body.replaceChildren(Object.assign(document.createElement('a'), { href: location.href, target: '_blank', rel: 'noopener', textContent: 'Abrir o RYVO' }));
  throw new Error('RYVO embutido em outro site');
}

const $ = id => document.getElementById(id);
const TELAS = ['inicio', 'verifica', 'erro', 'entrada', 'progresso', 'chamada'];
const mostra = id => TELAS.forEach(t => { $(t).hidden = t !== id; });
const guarda = { get: () => { try { return localStorage.getItem('ryvo.nome') || ''; } catch { return ''; } }, set: n => { try { localStorage.setItem('ryvo.nome', n); } catch {} } };
const params = new URLSearchParams(location.search);
const k = params.get('k'), sala = params.get('sala') ?? idFixo(k); // link fixo: só ?k= (D17); o temporário do fallback traz ?sala=

let ctl = null, estadoAtual = null, avisoTimer, extraTimer;
const botao = (txt, f) => Object.assign(document.createElement('button'), { textContent: txt, onclick: f });
const mk = (tag, cls, txt) => Object.assign(document.createElement(tag), { className: cls, textContent: txt });
// Avatar: inicial decorativa sobre a cor do hash do nome. A cor vai por CLASSE: a CSP (style-src 'self') bloqueia style= por atributo.
const avatar = nome => {
  const a = mk('span', 'avatar c' + corAvatar(nome), nome && String.fromCodePoint(nome.codePointAt(0)).toUpperCase());
  a.setAttribute('aria-hidden', 'true');
  return a;
};

const ui = {
  mostra,
  erro({ msg, id, nota, copiar, tentar, pedir }) {
    clearTimeout(extraTimer);
    $('erro-msg').textContent = msg;
    $('erro-id').textContent = id ?? ''; $('erro-id').hidden = !id;
    $('erro-nota').textContent = nota ?? ''; $('erro-nota').hidden = !nota;
    $('erro-copiar').hidden = !copiar;
    $('erro-copiar').onclick = async () => { try { await navigator.clipboard.writeText(id); $('erro-copiar').textContent = 'Copiado'; } catch {} };
    $('erro-tentar').hidden = !tentar; $('erro-tentar').onclick = tentar ?? null;
    $('erro-pedir').hidden = !pedir;
    mostra('erro');
  },
  passo(n, estado, txt) {
    $('p' + n).className = estado;
    if (txt !== undefined) $('p' + n).textContent = txt;
    if (n === 1 && estado === 'ativo') { $('p1-extra').hidden = true; extraTimer = setTimeout(() => { $('p1-extra').hidden = false; }, 2000); }
    if (n === 1 && estado === 'feito') { clearTimeout(extraTimer); $('p1-extra').hidden = true; }
  },
  video(stream, local) {
    $('video').srcObject = stream; $('video').muted = !!local;
    $('palco').hidden = !stream;
    if (stream) $('video').play().catch(() => {});
    desenha();
  },
  aviso(txt) {
    $('aviso').textContent = txt; $('aviso').hidden = false;
    clearTimeout(avisoTimer); avisoTimer = setTimeout(() => { $('aviso').hidden = true; }, 5000);
  },
  codigo(dica) { // a participação não foi confirmada e falta o código: o formulário volta, com o aviso
    $('g-dica').textContent = dica; $('g-dica').hidden = false;
    $('g-codigo').required = true;
    mostra('entrada');
    $('g-codigo').focus();
  },
  estado(e) { estadoAtual = e; desenha(); },
  ctl: c => aoEntrar(c),
};

const desenha = () => {
  const e = estadoAtual;
  if (!e) return;
  const anf = e.membros.find(m => m.id === e.anfitriao);
  $('sala-nome').textContent = anf ? `Sala de ${anf.nome}` : 'Sala';
  $('status').textContent = `${e.membros.length}/${TETO} na sala · Voz conectada`;
  $('contagem').textContent = `${e.membros.length}/${TETO}`;
  $('membros').replaceChildren(...e.membros.map(m => {
    const item = mk('li', m.id === e.anfitriao ? 'anf' : '', '');
    item.append(avatar(m.nome), mk('span', 'nome', m.nome));
    if (m.id === e.eu) item.append(mk('span', 'voce', 'você'));
    return item;
  }));
  const sou = e.eu === e.anfitriao, cheia = e.membros.length >= TETO;
  $('convite').hidden = !sou; $('espera').hidden = !sou || !e.fila.length;
  if (sou) {
    $('link').value = e.link; $('codigo').textContent = e.codigo; $('convite-nota').textContent = e.nota ?? '';
    $('fila-n').textContent = String(e.fila.length);
    $('fila').replaceChildren(...e.fila.map(f => {
      const item = mk('li', '', ''), quem = mk('div', 'quem', ''), acoes = mk('div', 'acoes', ''), aceitar = botao('Aceitar', () => ctl.aceitar(f.id));
      aceitar.className = 'primario'; aceitar.disabled = cheia;
      quem.append(mk('span', 'nome', f.nome));
      if (cheia) quem.append(mk('small', 'dica', MSG.aguardeVaga));
      acoes.append(aceitar, botao('Recusar', () => ctl.recusar(f.id)));
      item.append(avatar(f.nome), quem, acoes);
      return item;
    }));
  }
  $('faixa').textContent = e.tela ? `${e.tela.nome} está compartilhando` : '';
  $('tela-t').textContent = e.compartilhando ? 'Parar de compartilhar' : 'Compartilhar tela';
  const c = e.compartilhando ? '' : e.custo($('preset').value);
  $('custo').textContent = c; $('custo').hidden = !c;
};

const microfone = async () => {
  try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); } catch { return null; }
};
const aoEntrar = c => { ctl = c; };

const nomeDoCampo = () => limpaNome($('nome').value.trim().slice(0, 24)) || 'Anfitrião';
$('abrir').onclick = async () => {
  const nome = nomeDoCampo();
  guarda.set(nome);
  aoEntrar(await abreSala({ nome, mic: await microfone(), ui }));
};
$('ir').onclick = () => {
  try { const u = new URL($('colar').value.trim()); if (u.searchParams.get('sala') || idFixo(u.searchParams.get('k'))) location.search = u.search; } catch {}
};
$('entrada').onsubmit = async ev => {
  ev.preventDefault();
  const nome = limpaNome($('g-nome').value.trim());
  if (!nome) return;
  guarda.set(nome);
  aoEntrar(await entra({ sala, k, nome, codigo: $('g-codigo').value.trim(), mic: await microfone(), ui }));
};
$('g-sair').onclick = () => { ctl?.sai(); location.assign(location.pathname + location.search); };
$('desligar').onclick = () => { ctl?.sai(); location.assign(location.pathname); };
$('erro-voltar').onclick = () => location.assign(location.pathname);
$('mic').onclick = () => { const p = $('mic').getAttribute('aria-pressed') !== 'true'; $('mic').setAttribute('aria-pressed', String(p)); ctl?.mudo(p); };
$('tela').onclick = () => (estadoAtual?.compartilhando ? ctl.solta() : ctl.pega($('preset').value));
$('preset').onchange = desenha;
$('copiar').onclick = async () => { try { await navigator.clipboard.writeText($('link').value); $('copiar').querySelector('.t').textContent = 'Copiado'; } catch {} };
$('copiar-codigo').onclick = async () => { try { await navigator.clipboard.writeText($('codigo').textContent); $('copiar-codigo').classList.add('ok'); $('copiar-codigo').setAttribute('aria-label', 'Código copiado'); } catch {} };

// Pedir acesso (D7): o certificado persistente nasce AGORA, no clique; o admin recebe nome, aparelho e ID pelo WhatsApp.
const pedeAcesso = async () => {
  const r = await preparaCert();
  const aparelho = prompt('Nome deste aparelho (até 24 caracteres)');
  if (aparelho === null) return;
  const texto = textoPedido(nomeDoCampo(), aparelho.trim(), r.fp ?? r.expirado.fp);
  if (!texto) return ui.erro({ msg: MSG.aparelhoInvalido });
  // O prompt pode durar mais que a ativação do clique (~5 s no Chrome): aí o bloqueador de pop-up engole o window.open em silêncio.
  // Sem 'noopener' o retorno diz se abriu (null = bloqueado); bloqueado, vai ao wa.me nesta aba.
  const w = window.open(urlPedido(ADMIN_WA, texto), '_blank');
  if (w) w.opener = null; else location.assign(urlPedido(ADMIN_WA, texto));
};
$('pedir').onclick = $('erro-pedir').onclick = pedeAcesso;
let presenca = null; // id do setInterval da sondagem; o fecho dele segura o certificado persistente em memória
$('sair-grupo').onclick = async () => {
  await sairDoGrupo();
  clearInterval(presenca); presenca = null; desenhaSalas([]); // a sondagem para, o painel some e o certificado sai da memória (B1)
  $('sair-grupo').hidden = true; $('g-codigo').required = true;
};

$('nome').value = $('g-nome').value = guarda.get();
temCert().then(tem => { $('sair-grupo').hidden = !tem; $('g-codigo').required = !tem; }); // com certificado persistente o código é opcional (entra como membro)

// Painel de salas conhecidas (D8): uma linha por sala, só depois de uma rodada de sondagem. Tudo por textContent; o link é ?k= (fixo).
const desenhaSalas = lista => {
  $('salas').hidden = !lista.length;
  $('salas-lista').replaceChildren(...lista.map(s => {
    const item = mk('li', '', ''), a = mk('a', '', s.estado === 'aberta' ? (s.dentro?.length ? `${s.nome}: aberta · ${s.dentro.join(', ')}` : `${s.nome}: aberta`) : `${s.nome}: fechada`);
    a.href = location.pathname + '?k=' + s.k;
    item.append(avatar(s.nome), a, botao('Esquecer', () => { gravaSalas(salasConhecidas().filter(x => x.k !== s.k)); desenhaSalas(lista.filter(x => x.k !== s.k)); }));
    return item;
  }));
};
// Só quem tem certificado persistente válido sonda (visitante não tem lista nem painel).
certSeExiste().then(c => { if (c) presenca = ligaPresenca({ cert: c.cert, ativa: () => !$('inicio').hidden, aoMudar: l => presenca && desenhaSalas(l) }); }); // `presenca` nulo: rodada em voo não redesenha depois de Sair
if (sala) {
  mostra('entrada');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sala) || !/^[0-9a-f]{64}$/.test(k || '')) ui.erro({ msg: MSG.linkIncompleto });
} else mostra('inicio');
