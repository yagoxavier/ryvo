// Convidado: confere o anfitrião (allowlist + certificado do link) ANTES de mandar nome e código.
import { MSG, TITULO, valida, confere, guardaSala } from './puro.js';
import { consultaAllow, certDoConvidado, opcoesPeer, salasConhecidas, gravaSalas } from './identidade.js';
import { Voz, tocar } from './voz.js';
import { Tela } from './tela.js';

const FECHA_MS = 300;

// sala = peerId do anfitrião; k = impressão dele (do link). ui: { mostra, erro, passo, estado, video, aviso, codigo, ctl }.
// Devolve os controles (ctl) para a chamada. A tentativa inteira recomeça com `tentar` (botão "Tentar de novo").
export const entra = async ({ sala, k, nome, codigo, mic, ui }) => {
  let fim = false, enviou = false, aceito = false, allowOk = false, conectado = false, erros = 0, persistente = false, comoMembro = false, renovado = null;
  let peer, c, voz, tela, membros = [], eu = null;
  const encerra = (msg, extra = {}) => {
    if (fim) return;
    fim = true;
    tela?.para();
    if (!extra.tentar) mic?.getTracks().forEach(t => t.stop()); // "Tentar de novo" reusa este mic
    setTimeout(() => peer?.destroy(), FECHA_MS);
    ui.erro({ msg, ...extra });
  };
  const tentar = () => entra({ sala, k, nome, codigo, mic, ui }).then(ui.ctl);
  const ctl = {
    pega: preset => tela?.pega(preset), solta: () => tela?.solta(),
    mudo: m => mic?.getAudioTracks().forEach(t => { t.enabled = !m; }),
    sai() {
      if (fim) return;
      fim = true;
      c?.open && c.send({ t: 'sair' });
      tela?.para();
      mic?.getTracks().forEach(t => t.stop());
      setTimeout(() => peer?.destroy(), FECHA_MS);
    },
  };

  addEventListener('pagehide', ctl.sai);
  ui.mostra('progresso');
  ui.passo(1, 'ativo');
  // Acaba esta tentativa SEM tela de erro e devolve o formulário (falta o código ou ele veio errado); o app pede o código e chama `entra` de novo.
  const voltaAoFormulario = (dica = renovado ? MSG.certRenovado : MSG.pedeCodigo) => { // o aviso de renovação não pode se perder quando a 1ª tentativa vem sem código
    fim = true;
    c?.open && c.send({ t: 'sair' });
    mic?.getTracks().forEach(t => t.stop());
    setTimeout(() => peer?.destroy(), FECHA_MS);
    ui.codigo(dica);
  };
  const tenta = () => { // só com allowlist 'sim' E canal aberto E impressão conferida
    if (fim || enviou || !allowOk || !conectado) return;
    if (!persistente && !codigo) return voltaAoFormulario(); // sem certificado persistente o código é obrigatório
    enviou = true;
    comoMembro = persistente;
    ui.passo(3, 'ativo', comoMembro ? MSG.conferindo : undefined);
    c.send(comoMembro ? { t: 'membro', nome } : { t: 'entrar', nome, codigo });
  };
  // O anfitrião não confirmou a participação: com o código digitado, segue por ele; sem, volta ao formulário.
  const pedeCodigo = () => {
    if (!comoMembro || aceito) return;
    comoMembro = false;
    if (!codigo) return voltaAoFormulario();
    ui.passo(3, 'ativo', MSG.aguardando);
    c.send({ t: 'entrar', nome, codigo });
  };

  // (a) allowlist e (b) conexão correm em paralelo: a espera é a maior das duas, não a soma.
  consultaAllow(k).then(v => {
    if (fim) return;
    if (v === 'sim') { allowOk = true; ui.passo(1, 'feito'); ui.passo(2, 'ativo'); return tenta(); }
    encerra(v === 'nao' ? MSG.naoAutorizado : MSG.foraDoAr, v === 'nao' ? { titulo: TITULO.naoAutorizado } : { titulo: TITULO.foraDoAr, tentar });
  });

  const cs = await certDoConvidado(); // persistente só de quem pediu acesso (D11); visitante: só da sessão, nada é gravado
  if (fim) return ctl;
  persistente = cs.persistente; renovado = cs.renovado ?? null;
  peer = new Peer(opcoesPeer(cs.cert));
  // Queda só do servidor de sinalização não derruba a sala; sem isto o convidado deixaria de receber chamadas de tela.
  // O PeerJS emite `error` (network) ANTES de `disconnected`: depois de conectado, quem encerra é o close do canal (abaixo).
  peer.on('disconnected', () => !fim && !peer.destroyed && peer.reconnect());
  peer.on('error', e => !fim && !conectado && encerra(e.type === 'peer-unavailable' ? MSG.salaFechada : MSG.erroRede(e.type), { titulo: e.type === 'peer-unavailable' ? TITULO.salaFechada : TITULO.semConexao, tentar }));
  peer.on('open', () => {
    c = peer.connect(sala, { serialization: 'json' });
    c.on('open', () => {
      if (fim) return;
      // DTLS conectado (o canal abriu). A impressão do certificado dele tem de ser a do link.
      if (!confere(c.peerConnection.remoteDescription.sdp, k)) return encerra(MSG.impostor, { titulo: TITULO.impostor });
      conectado = true;
      ui.passo(2, 'feito');
      tenta();
    });
    c.on('close', () => { if (!fim) encerra(aceito ? MSG.fim : MSG.caiu, { titulo: aceito ? TITULO.fim : TITULO.caiu }); });
    c.on('data', d => {
      if (fim) return;
      if (!valida(d, 'anfitriao') || !enviou) { if (++erros >= 3) c.close(); return; }
      switch (d.t) {
        case 'errado': return voltaAoFormulario(MSG.errado); // código errado: o formulário volta com o nome e o aviso (S04 R11)
        case 'trancada': case 'cheia': case 'recusado': return encerra(MSG[d.t], { titulo: TITULO[d.t] });
        case 'fim': return encerra(MSG.fim, { titulo: TITULO.fim });
        case 'espera': return;
        case 'pedeCodigo': return pedeCodigo();
        case 'aceito': return aceito || aceita(d);
        default: if (aceito) depois(d);
      }
    });
  });

  const notifica = () => ui.estado({
    eu, anfitriao: sala, membros: membros.map(m => ({ id: m.id, nome: m.nome })), tela: tela.atual, compartilhando: tela.atual?.id === eu,
    fila: [], custo: p => tela.custo(p),
  });
  const aceita = d => {
    aceito = true; eu = d.eu; membros = d.membros;
    // Quem tem certificado persistente lembra desta sala (só a impressão do anfitrião e o nome dele; nada secreto) para a presença.
    const anf = persistente && membros.find(m => m.id === sala);
    if (anf) gravaSalas(guardaSala(salasConhecidas(), k, anf.nome));
    tela = new Tela({
      peer, eu, membros: () => membros, ui: { ...ui, muda: notifica },
      pede: m => c.send(m),
    });
    voz = new Voz(c.peerConnection, true, x => c.open && c.send({ t: 'neg', d: x }));
    voz.aoTrilha = tocar;
    if (mic) voz.pc.addTrack(mic.getAudioTracks()[0], mic);
    tela.aplica(d.tela);
    ui.mostra('chamada');
    notifica();
    if (renovado) ui.aviso(MSG.certRenovado);
  };
  const depois = d => {
    if (d.t === 'neg') return voz.recebe(d.d);
    if (d.t === 'chegou') { const m = { id: d.id, fp: d.fp, nome: d.nome }; membros = [...membros, m]; tela.chegou(m); }
    if (d.t === 'saiu') { membros = membros.filter(m => m.id !== d.id); tela.saiu(d.id); }
    if (d.t === 'tela') tela.aplica(d.id ? { id: d.id, nome: d.nome } : null);
    notifica();
  };
  return ctl;
};
