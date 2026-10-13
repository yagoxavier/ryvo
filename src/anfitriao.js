// Anfitrião: dono do certificado persistente, porteiro (código + sala de espera) e hub de voz.
import { MSG, TITULO, Sala, valida, fpUnico, montaMembro, novoPin, dataBr, idFixo, mistura, CacheMembros, ENTRAR_MS } from './puro.js';
import { preparaCert, consultaAllow, opcoesPeer, tokenSessao } from './identidade.js';
import { Voz, tocar } from './voz.js';
import { Tela } from './tela.js';

const FECHA_MS = 500; // dá tempo da última mensagem sair antes de fechar

// ui: { mostra, erro, estado, video, aviso }. mic: MediaStream | null. Devolve os controles da sala (ou null se não abriu).
export const abreSala = async ({ nome, mic, ui }) => {
  ui.mostra('verifica');
  const id = await preparaCert();
  if (id.expirado) {
    ui.erro({ titulo: TITULO.expirou, msg: MSG.expirou(dataBr(id.expirado.em)), id: id.expirado.fp, nota: MSG.expirouNota, copiar: true, pedir: true });
    return null;
  }
  const { cert, fp } = id;
  const abrir = p => new Promise((ok, no) => { p.on('open', ok); p.on('error', no); });
  // Uma aba anfitriã por perfil: "Duplicar aba" copia o sessionStorage (mesmo token) e as duas se derrubariam do ID fixo sem fim.
  // A trava vive até a página morrer (toda saída recarrega). Sem trava (outra aba deste perfil já hospeda): direto ao ID sorteado (D9).
  let solta = () => {}; // devolve a trava: quem para em #erro sem recarregar não pode segurar o ID fixo das outras abas
  let fixo = await new Promise(ok => navigator.locks.request('ryvo.anfitriao', { ifAvailable: true }, t => { ok(!!t); return t && new Promise(r => { solta = r; }); }));
  let peer = fixo ? new Peer(idFixo(fp), opcoesPeer(cert, tokenSessao())) : new Peer(opcoesPeer(cert));
  const consulta = consultaAllow(fp); // em paralelo com a abertura: o Apps Script diz se esta impressão é de membro
  let meu = await abrir(peer).catch(e => e); // o ID aberto (string) ou o erro do Peer
  if (meu?.type === 'unavailable-id') { // ID fixo ocupado por outro token (outra aba, zumbi, ocupante): cai no ID sorteado e no link temporário (D9)
    peer.destroy();
    peer = new Peer(opcoesPeer(cert));
    fixo = false;
    meu = await abrir(peer).catch(e => e);
  }
  if (typeof meu !== 'string') {
    peer.destroy();
    solta();
    ui.erro({ titulo: TITULO.semConexao, msg: MSG.erroRede(meu?.type ?? 'desconhecido') });
    return null;
  }
  if ((await consulta) !== 'sim') {
    peer.destroy();
    solta();
    ui.erro({ titulo: TITULO.semPermissao, msg: MSG.semPermissao, id: fp, copiar: true, pedir: true });
    return null;
  }

  const pin = novoPin(); // só em memória
  const sala = new Sala(meu, nome, fp);
  const links = new Map(); // id do convidado -> { c, nome, fp, membro, feito, pediuCodigo, erros, voz, envios: Map(origem -> sender) }
  const remotas = new Map(); // id do convidado -> trilha de áudio dele
  let fim = false;
  const link = location.origin + location.pathname + '?' + (fixo ? '' : 'sala=' + meu + '&') + 'k=' + fp; // fixo: só ?k=; o temporário (fallback) traz ?sala=

  const membrosLista = () => [...sala.membros.values()];
  const paraMembros = (m, exceto) => { for (const [i, l] of links) if (l.membro && i !== exceto) l.c.open && l.c.send(m); };
  const tela = new Tela({
    peer, eu: meu, membros: membrosLista, ui: { ...ui, muda: () => notifica() },
    pede: m => { if (m.t === 'pegar') sala.pegar(meu); else sala.soltar(meu); difundeTela(); },
  });
  const notifica = () => ui.estado({
    eu: meu, anfitriao: meu, membros: membrosLista().map(m => ({ id: m.id, nome: m.nome })), tela: sala.tela, compartilhando: sala.tela?.id === meu,
    fila: [...sala.pend].filter(([, s]) => s === 'espera').map(([i]) => ({ id: i, nome: links.get(i).nome })),
    link, nota: fixo ? MSG.linkFixo : MSG.linkOcupado, codigo: pin, custo: p => tela.custo(p),
  });
  const difundeTela = () => {
    paraMembros({ t: 'tela', id: sala.tela?.id ?? null, nome: sala.tela?.nome ?? null });
    tela.aplica(sala.tela);
    notifica();
  };
  const encaminha = (de, trilha, para) => { // anfitrião reencaminha a trilha remota de `de` ao link `para` (sem mixar)
    const l = links.get(para);
    if (!l?.membro || l.envios.has(de)) return;
    // Reusa a m-line de quem saiu (replaceTrack não renegocia); addTrack só sem vaga. Sem isto cada entra-e-sai soma
    // ~1,2 kB à oferta, que passa dos 16300 bytes do canal JSON do PeerJS e é descartada em silêncio.
    const usados = new Set(l.envios.values());
    const vaga = l.voz.pc.getTransceivers().find(t => !t.sender.track && !usados.has(t.sender) && /send/.test(t.currentDirection ?? ''));
    if (vaga) { vaga.sender.replaceTrack(trilha).catch(() => {}); l.envios.set(de, vaga.sender); return; }
    l.envios.set(de, l.voz.pc.addTrack(trilha, new MediaStream([trilha])));
  };
  const saiu = i => {
    const l = links.get(i);
    if (!l) return;
    links.delete(i);
    const eraMembro = sala.sai(i);
    remotas.delete(i);
    if (eraMembro) {
      paraMembros({ t: 'saiu', id: i });
      for (const o of links.values()) { const s = o.envios.get(i); if (s) { s.replaceTrack(null).catch(() => {}); o.envios.delete(i); } }
      tela.saiu(i);
      if (sala.soltar(i)) difundeTela();
    }
    notifica();
  };

  const cache = new CacheMembros(); // vereditos do script só para a sondagem; o `membro` nunca usa
  let tomado = false; // o ID fixo foi tomado enquanto a sinalização estava fora: reconectar só daria ID-TAKEN de novo, sem fim
  peer.on('error', e => { if (e.type === 'unavailable-id') { tomado = true; ui.aviso(MSG.linkTomado); } });
  peer.on('disconnected', () => !fim && !peer.destroyed && !tomado && peer.reconnect());
  peer.on('connection', c => {
    if (fim || links.has(c.peer) || !sala.chega(c.peer)) return c.close();
    const l = { c, nome: '', fp: null, membro: false, feito: null, pediuCodigo: false, erros: 0, voz: null, envios: new Map() };
    links.set(c.peer, l);
    const invalida = () => { if (++l.erros >= 3) c.close(); };
    // Sonda (D12): só quer saber de presença. Responde e fecha; não vira entrada nem aparece na UI (a UI só lista a fila de espera).
    // Só membro (veredito 'sim' do script, via cache da sonda) recebe os nomes; falha, teto de consultas ou não-membro: dentro:null.
    const sondagem = async () => {
      const p = cache.consulta(l.fp, Date.now(), consultaAllow); // null = teto de consultas em voo
      const v = p ? await p : 'falha';
      c.open && c.send({ t: 'presenca', dentro: v === 'sim' ? membrosLista().map(m => m.nome) : null });
      setTimeout(() => c.close(), FECHA_MS);
    };
    // Membro: consulta o script sobre a impressão que EU li do SDP (nunca a declarada). Uma consulta por conexão (a guarda `l.feito === d.t`), sem cache:
    // a revogação vale na próxima entrada. Qualquer coisa diferente de 'sim' (inclusive falha) vira pedeCodigo: falha fechada.
    const entraMembro = async d => {
      l.nome = d.nome;
      const v = await consultaAllow(l.fp);
      if (fim || !c.open) return;
      if (v !== 'sim') {
        l.pediuCodigo = true; // agora `entrar` vale nesta conexão, dentro do prazo
        c.send({ t: 'pedeCodigo' });
        setTimeout(() => l.feito !== 'entrar' && c.close(), ENTRAR_MS);
        return;
      }
      const r = sala.admite(c.peer, l.nome, l.fp);
      if (r === 'cheia') { c.send({ t: 'cheia' }); setTimeout(() => c.close(), FECHA_MS); return; }
      if (r === 'ok') { entrou(c.peer, l); ui.aviso(MSG.entrou(l.nome)); }
    };
    c.on('close', () => saiu(c.peer));
    // Não abriu em ENTRAR_MS (ICE travada ou falhou): o PeerJS só emite 'close' de conexão aberta, então limpa aqui.
    setTimeout(() => { if (!c.open) { c.close(); saiu(c.peer); } }, ENTRAR_MS);
    c.on('open', () => {
      l.fp = fpUnico(c.peerConnection.remoteDescription.sdp); // a impressão que EU li do SDP, não a que o convidado declara
      if (!l.fp) return c.close();
      setTimeout(() => !l.feito && c.close(), ENTRAR_MS);
    });
    c.on('data', d => {
      if (!valida(d, 'convidado')) return invalida();
      if (d.t === 'sair') return c.close();
      if (d.t === 'neg') return l.membro ? l.voz.recebe(d.d) : invalida();
      if (d.t === 'pegar' || d.t === 'soltar') {
        if (!l.membro) return invalida();
        if (d.t === 'pegar' ? sala.pegar(c.peer) : sala.soltar(c.peer)) difundeTela();
        return;
      }
      // Daqui em diante d.t é entrar, membro ou sondar: uma conexão faz uma coisa só (misturar é erro da conexão).
      if (mistura(l.feito, d.t, l.pediuCodigo)) return invalida();
      if (l.feito === d.t) return; // repetir o mesmo: ignorado (uma tentativa, uma consulta ou uma sondagem por conexão)
      l.feito = d.t;
      if (d.t === 'sondar') return sondagem();
      if (d.t === 'membro') return entraMembro(d);
      // d.t === 'entrar': uma tentativa por conexão (força bruta exige uma conexão WebRTC nova a cada chute)
      const r = sala.tenta(d.codigo === pin);
      if (r !== 'ok') { c.send({ t: r }); setTimeout(() => c.close(), FECHA_MS); return notifica(); }
      l.nome = d.nome;
      const e = sala.espera(c.peer);
      if (e === 'cheia') { c.send({ t: 'cheia' }); setTimeout(() => c.close(), FECHA_MS); return; }
      c.send({ t: 'espera' });
      notifica();
    });
  });

  // Hub de voz: a trilha que chega de um convidado vai para o anfitrião ouvir e para os OUTROS convidados.
  const liga = (i, l) => {
    l.voz = new Voz(l.c.peerConnection, false, d => l.c.open && l.c.send({ t: 'neg', d }));
    l.voz.aoTrilha = t => {
      if (remotas.has(i)) return;
      remotas.set(i, t);
      tocar(t);
      for (const j of links.keys()) if (j !== i) encaminha(i, t, j);
    };
  };

  // Corpo comum de quem entra na sala (aceito pelo anfitrião ou admitido como membro): voz, lista, avisos e áudio do anfitrião.
  const entrou = (i, l) => {
    l.membro = true;
    liga(i, l);
    l.c.send({ t: 'aceito', eu: i, membros: membrosLista(), tela: sala.tela });
    const novo = montaMembro(i, l.nome, l.c.peerConnection.remoteDescription.sdp);
    paraMembros({ t: 'chegou', ...novo }, i);
    tela.chegou(novo);
    if (mic) l.envios.set(meu, l.voz.pc.addTrack(mic.getAudioTracks()[0], mic)); // a voz do anfitrião
    for (const [de, t] of remotas) encaminha(de, t, i);
    notifica();
  };

  const ctl = {
    aceitar(i) {
      const l = links.get(i);
      if (!l) return;
      const r = sala.aceita(i, l.nome, l.fp);
      if (r === 'nao') return;
      if (r === 'cheia') { l.c.send({ t: 'cheia' }); setTimeout(() => l.c.close(), FECHA_MS); return notifica(); }
      entrou(i, l);
    },
    recusar(i) {
      const l = links.get(i);
      if (!l) return;
      sala.sai(i); // sai da fila já: até o close (FECHA_MS) o recusado continuaria na lista e aceitável
      notifica();
      l.c.send({ t: 'recusado' });
      setTimeout(() => l.c.close(), FECHA_MS);
    },
    pega: preset => tela.pega(preset),
    solta: () => tela.solta(),
    mudo: m => mic?.getAudioTracks().forEach(t => { t.enabled = !m; }),
    sai() {
      if (fim) return;
      fim = true;
      for (const l of links.values()) l.c.open && l.c.send({ t: 'fim' });
      tela.para();
      mic?.getTracks().forEach(t => t.stop());
      setTimeout(() => peer.destroy(), FECHA_MS);
    },
  };
  addEventListener('pagehide', () => ctl.sai());
  ui.mostra('chamada');
  notifica();
  return ctl;
};
