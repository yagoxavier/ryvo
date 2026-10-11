// Compartilhamento de tela de um membro (anfitrião ou convidado): captura, envio direto a cada outro membro
// e recepção. Quem manda em "quem compartilha" é o anfitrião; aqui só se obedece a `aplica(tela)`.
import { PRESETS, confere, chamadaOk, custoBanda } from './puro.js';

// Opus sai mono ~32 kbps por padrão; na ligação de TELA pede estéreo e mais bitrate. A voz NÃO usa isto (R7neg3).
export const stereo = sdp => sdp.replace(/useinbandfec=1/g, 'useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000');
const ESPERA_TELA_MS = 3000;

export class Tela {
  // o = { peer, eu, membros: () => [{id,fp,nome}], pede: m => void (envia pegar/soltar), ui: { video(stream|null, local), aviso(txt), muda() } }
  constructor(o) {
    Object.assign(this, o);
    this.atual = null; // {id, nome} ou null: quem compartilha segundo o anfitrião
    this.envio = null; // {stream, cfg, chamadas: Map(id -> MediaConnection)} quando EU compartilho
    this.confirmado = false; // o anfitrião já disse que a tela é minha? (antes disso, um `tela` alheio só pode ser anterior ao meu pegar)
    this.entrada = null; // chamada de vídeo que estou recebendo
    this.segurando = new Set(); // chamadas que chegaram antes do `tela` que as autoriza
    o.peer.on('call', c => this.recebe(c));
  }
  custo(preset) { return custoBanda(this.membros().length - 1, preset).texto; }

  recebe(c) {
    const sdp = c.options?._payload?.sdp?.sdp ?? '';
    if (chamadaOk(this.atual, this.membros(), c.peer, sdp)) return this.atende(c);
    // Pode ser que o `tela` do anfitrião ainda não tenha chegado: espera um pouco e reavalia.
    this.segurando.add(c);
    setTimeout(() => { if (this.segurando.delete(c)) c.close(); }, ESPERA_TELA_MS);
  }
  atende(c) {
    this.segurando.delete(c);
    this.entrada?.close();
    this.entrada = c;
    c.answer(undefined, { sdpTransform: stereo });
    c.on('stream', s => this.entrada === c && this.ui.video(s, false));
    c.on('close', () => { if (this.entrada === c) { this.entrada = null; this.ui.video(null, false); } });
  }

  // `tela` do anfitrião: {id, nome} ou null.
  aplica(t) {
    const era = this.atual;
    this.atual = t;
    if (this.entrada && this.entrada.peer !== t?.id) this.entrada.close();
    if (!t) this.ui.video(null, false);
    if (this.envio && t?.id === this.eu) {
      this.confirmado = true;
      for (const m of this.membros()) if (m.id !== this.eu) this.chama(m);
    } else if (this.envio && this.confirmado) {
      const quem = t?.nome;
      this.para();
      if (quem) this.ui.aviso(`${quem} assumiu a tela`);
    }
    for (const c of [...this.segurando]) if (chamadaOk(t, this.membros(), c.peer, c.options?._payload?.sdp?.sdp ?? '')) this.atende(c);
    if (era?.id !== t?.id) this.ui.muda();
  }

  // Clique em "Compartilhar": captura a tela e pede ao anfitrião. Assume na hora (sem diálogo).
  async pega(preset) {
    const cfg = PRESETS[preset];
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: cfg.w }, height: { ideal: cfg.h }, frameRate: { ideal: cfg.fps } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true },
      });
    } catch { return; } // cancelou a janela de escolha
    stream.getVideoTracks()[0].contentHint = cfg.hint;
    stream.getVideoTracks()[0].onended = () => this.solta();
    this.para();
    this.envio = { stream, cfg, chamadas: new Map() };
    this.confirmado = false;
    this.ui.video(stream, true);
    this.pede({ t: 'pegar' });
    if (this.atual?.id === this.eu) this.aplica(this.atual); // já era meu: religa as chamadas
  }
  solta() {
    if (!this.envio) return;
    this.para();
    this.pede({ t: 'soltar' });
  }
  para() {
    if (!this.envio) return;
    this.envio.chamadas.forEach(c => c.close());
    this.envio.stream.getTracks().forEach(t => t.stop());
    this.envio = null;
    this.confirmado = false;
    this.ui.video(null, true);
  }

  chama(m) {
    const e = this.envio;
    if (!e || e.chamadas.has(m.id)) return;
    const c = this.peer.call(m.id, e.stream, { sdpTransform: stereo });
    e.chamadas.set(m.id, c);
    const pc = c.peerConnection;
    // A ligação de vídeo confere o certificado de quem atende contra a impressão que o anfitrião listou.
    pc.addEventListener('signalingstatechange', () => { if (pc.signalingState === 'stable' && !confere(pc.remoteDescription.sdp, m.fp)) c.close(); });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') return c.close();
      if (pc.connectionState !== 'connected') return;
      // O teto padrão do WebRTC para tela é baixo; sobe o maxBitrate do vídeo depois de conectar.
      for (const s of pc.getSenders()) {
        if (s.track?.kind !== 'video') continue;
        const p = s.getParameters();
        if (!p.encodings?.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = e.cfg.mbps * 1e6;
        s.setParameters(p).catch(() => {});
      }
    });
  }
  chegou(m) { if (this.envio && this.atual?.id === this.eu) this.chama(m); }
  saiu(id) { const c = this.envio?.chamadas.get(id); c?.close(); this.envio?.chamadas.delete(id); }
}
