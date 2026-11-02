# -*- coding: utf-8 -*-
"""
IA da Rafa Busca Peças no PC — fotos e vídeos.
Busca os pedidos no sistema e devolve o resultado. Não precisa abrir porta no
roteador: é o PC que chama o sistema.
- Fotos (qualquer placa): recorte BiRefNet (ONNX pelo DirectML: AMD, NVIDIA
  ou Intel), melhoria Real-ESRGAN (Vulkan na AMD/Intel, CUDA na NVIDIA) e luz,
  com trava de integridade.
- Vídeos: placa NVIDIA com 12 GB+ → IA de vídeo (Wan 2.2 / LTX-Video);
  outras placas (ex.: AMD RX 6600) → vídeo cinematográfico feito com a foto
  real (câmera se aproximando e luz de estúdio; a peça não muda).
"""
import importlib, io, json, os, subprocess, sys, tempfile, time, traceback, urllib.error, urllib.parse, urllib.request, zipfile

VERSAO = '2.0'
PASTA = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(PASTA, 'config.json'), encoding='utf-8-sig') as f:
    CFG = json.load(f)
SERVIDOR = CFG['servidor'].rstrip('/')
TOKEN = CFG['token']
PASSOS = int(CFG.get('passos', 30))


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def req(metodo, caminho, dados=None, tipo='application/json', extra=None, timeout=60):
    h = {'Authorization': 'Bearer ' + TOKEN, 'User-Agent': 'RafaGerador/' + VERSAO}
    if isinstance(dados, (dict, list)):
        dados = json.dumps(dados).encode('utf-8')
    if dados is not None:
        h['Content-Type'] = tipo
    if extra:
        h.update(extra)
    r = urllib.request.Request(SERVIDOR + caminho, data=dados, method=metodo, headers=h)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        corpo = resp.read()
        if 'application/json' in (resp.headers.get('content-type') or ''):
            return json.loads(corpo or b'{}')
        return corpo


def baixa(url):
    r = urllib.request.Request(url, headers={'User-Agent': 'RafaGerador/' + VERSAO})
    with urllib.request.urlopen(r, timeout=120) as resp:
        return resp.read()


def baixa_arquivo(url, destino, nome):
    # arquivos grandes: baixa em partes, mostrando o andamento, e só troca quando termina
    if os.path.exists(destino):
        return destino
    log(f'Baixando {nome} (só na 1ª vez)...')
    r = urllib.request.Request(url, headers={'User-Agent': 'RafaGerador/' + VERSAO})
    with urllib.request.urlopen(r, timeout=120) as resp, open(destino + '.tmp', 'wb') as f:
        total, feito, aviso = int(resp.headers.get('content-length') or 0), 0, 0
        while True:
            bloco = resp.read(1024 * 1024)
            if not bloco:
                break
            f.write(bloco)
            feito += len(bloco)
            if total and feito * 100 // total >= aviso + 20:
                aviso = feito * 100 // total
                log(f'  {nome}: {aviso}%')
    os.replace(destino + '.tmp', destino)
    return destino


def atualiza_programa():
    # baixa a versão mais nova do programa do sistema; se mudou, troca e reinicia
    try:
        novo = baixa(SERVIDOR + '/agente/agente.py')
        atual = open(os.path.abspath(__file__), 'rb').read()
        if novo and b'VERSAO' in novo and b'def main' in novo and novo.replace(b'\r\n', b'\n') != atual.replace(b'\r\n', b'\n'):
            with open(os.path.abspath(__file__), 'wb') as f:
                f.write(novo)
            log('Programa atualizado. Reiniciando...')
            os.execv(sys.executable, [sys.executable, os.path.abspath(__file__)] + sys.argv[1:])
    except Exception as e:
        log('Não consegui verificar atualização (segue com a versão atual):', e)


atualiza_programa()


# ---------- modo do PC: NVIDIA (IA de vídeo) ou leve (AMD/Intel) ----------
torch = None
CUDA = False
try:
    import torch as _torch
    if _torch.cuda.is_available():
        torch, CUDA = _torch, True
except Exception:
    pass


def nome_placa():
    if CUDA:
        return torch.cuda.get_device_name(0), torch.cuda.get_device_properties(0).total_memory / 1024 ** 3
    try:
        if os.name == 'nt':
            r = subprocess.run(['powershell', '-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'],
                               capture_output=True, text=True, timeout=30)
            nomes = [l.strip() for l in r.stdout.splitlines() if l.strip()]
            if nomes:
                return ' / '.join(nomes)[:80], 0
    except Exception:
        pass
    return 'placa sem CUDA', 0


GPU, VRAM = nome_placa()
MODO_VIDEO = CFG.get('video', 'auto')
if MODO_VIDEO not in ('ia', 'cinema'):
    MODO_VIDEO = 'ia' if (CUDA and VRAM >= 12) else 'cinema'
if MODO_VIDEO == 'ia' and not CUDA:
    MODO_VIDEO = 'cinema'
MODELO = CFG.get('modelo', 'auto')
if MODO_VIDEO == 'cinema':
    MODELO = 'cinema'
elif MODELO not in ('wan', 'ltx'):
    MODELO = 'wan' if VRAM >= 20 else 'ltx'


def garante_dependencias():
    # instala sozinho o que faltar (o programa se atualiza e pode precisar de coisa nova)
    precisa = ['cv2', 'numpy', 'PIL', 'imageio', 'imageio_ffmpeg', 'onnxruntime']
    if MODO_VIDEO == 'ia':
        precisa += ['diffusers', 'transformers', 'accelerate', 'spandrel']
    faltando = []
    for mod in precisa:
        try:
            importlib.import_module(mod)
        except Exception:
            faltando.append(mod)
    if not faltando:
        return
    nome = 'requirements.txt' if MODO_VIDEO == 'ia' else 'requirements-leve.txt'
    log('Instalando componentes da IA:', ', '.join(faltando), '(só na 1ª vez)...')
    try:
        arq = os.path.join(PASTA, nome)
        with open(arq, 'wb') as f:
            f.write(baixa(SERVIDOR + '/agente/' + nome))
        subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', '-r', arq], check=False, timeout=3600)
    except Exception as e:
        log('Não consegui instalar tudo agora:', e)


garante_dependencias()

# tamanho do vídeo (vertical 9:16, bom pra Clips/Reels) e ajustes por modelo
if MODELO == 'wan':
    LARG, ALT, QUADROS, FPS, GUIA = 704, 1280, 121, 24, 5.0   # 5 s (esticado pra 10 s)
elif MODELO == 'ltx':
    LARG, ALT, QUADROS, FPS, GUIA = 480, 832, 121, 24, 3.0    # 5 s (esticado pra 10 s)
else:
    LARG, ALT, QUADROS, FPS, GUIA = 1080, 1920, 300, 30, 0     # vídeo cinematográfico: 10 s direto

PIPE = None


def carrega(job_id):
    global PIPE
    if PIPE is not None:
        return PIPE
    try:
        req('POST', '/api/agente/progresso/' + job_id, {'texto': 'preparando a IA (na 1ª vez baixa o modelo: pode levar de 30 min a 2 h)'})
    except Exception:
        pass
    if MODELO == 'wan':
        from diffusers import AutoencoderKLWan, WanImageToVideoPipeline
        mid = 'Wan-AI/Wan2.2-TI2V-5B-Diffusers'
        log('Carregando o modelo Wan 2.2 (na 1ª vez baixa uns 30 GB)...')
        vae = AutoencoderKLWan.from_pretrained(mid, subfolder='vae', torch_dtype=torch.float32)
        PIPE = WanImageToVideoPipeline.from_pretrained(mid, vae=vae, torch_dtype=torch.bfloat16)
        pouca_memoria = VRAM < 22
    else:
        from diffusers import LTXImageToVideoPipeline
        mid = 'Lightricks/LTX-Video'
        log('Carregando o modelo LTX-Video (na 1ª vez baixa uns 20 GB)...')
        PIPE = LTXImageToVideoPipeline.from_pretrained(mid, torch_dtype=torch.bfloat16)
        pouca_memoria = VRAM < 12
    if pouca_memoria:
        PIPE.enable_sequential_cpu_offload()   # mais lento, mas cabe em placa menor
    else:
        PIPE.enable_model_cpu_offload()
    try:
        PIPE.vae.enable_tiling()
    except Exception:
        pass
    log('Modelo pronto.')
    return PIPE


def prepara_imagem(dados):
    from PIL import Image
    im = Image.open(io.BytesIO(dados)).convert('RGB')
    s = min(LARG / im.width, ALT / im.height)
    nw, nh = max(1, int(im.width * s)), max(1, int(im.height * s))
    fundo = Image.new('RGB', (LARG, ALT), (255, 255, 255))   # peça inteira, sem cortar, fundo branco
    fundo.paste(im.resize((nw, nh), Image.LANCZOS), ((LARG - nw) // 2, (ALT - nh) // 2))
    return fundo


def salva_mp4(quadros, arq):
    import imageio
    import numpy as np
    n = 0
    with imageio.get_writer(arq, fps=FPS, codec='libx264', quality=8, pixelformat='yuv420p', macro_block_size=16) as w:
        for q in quadros:
            a = np.asarray(q)
            if a.dtype != np.uint8:
                a = (np.clip(a, 0, 1) * 255).astype('uint8')
            w.append_data(a)
            n += 1
    return n


def estica_para(arq, segundos, n_quadros):
    # deixa o vídeo com a duração pedida (ex.: 10 s) criando quadros intermediários (300 quadros a 30 fps);
    # se não der, faz ida e volta (o movimento de câmera vai e volta, a peça continua parada)
    import subprocess
    import imageio_ffmpeg
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    dur = max(1, n_quadros - 1) / FPS   # tempo entre o 1º e o último quadro
    if segundos <= dur + 0.2:
        return arq
    saida = arq.replace('.mp4', f'_{segundos}s.mp4')
    fator = segundos / dur
    try:
        subprocess.run([ff, '-y', '-loglevel', 'error', '-i', arq, '-filter:v',
                        f'setpts={fator:.4f}*PTS,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1,tpad=stop_mode=clone:stop_duration=2',
                        '-frames:v', str(int(segundos * 30)), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', saida],
                       check=True, timeout=1800)
        return saida
    except Exception as e:
        log('Interpolação falhou, usando ida e volta:', e)
    try:
        subprocess.run([ff, '-y', '-loglevel', 'error', '-i', arq, '-filter_complex', '[0:v]reverse[r];[0:v][r]concat=n=2:v=1[v]',
                        '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', saida],
                       check=True, timeout=600)
        return saida
    except Exception as e:
        log('Não consegui deixar com', segundos, 's; fica com', round(dur, 1), 's:', e)
        return arq


def gera(job):
    if MODELO == 'cinema':
        t0 = time.time()
        return video_cinema(job), time.time() - t0
    pipe = carrega(job['id'])
    img = prepara_imagem(baixa(job['foto_url']))
    total = PASSOS

    def progresso(_pipe, i, _t, kw):
        if i % 5 == 0:
            try:
                req('POST', '/api/agente/progresso/' + job['id'], {'texto': f'gerando: passo {i + 1} de {total}'})
            except Exception:
                pass
        return kw

    t0 = time.time()
    extra = {'max_sequence_length': 512} if MODELO == 'wan' else {}
    try:
        saida = pipe(image=img, prompt=job['prompt'], negative_prompt=job.get('negativo'), width=LARG, height=ALT,
                     num_frames=QUADROS, num_inference_steps=total, guidance_scale=GUIA, callback_on_step_end=progresso, **extra)
    except TypeError:
        saida = pipe(image=img, prompt=job['prompt'], negative_prompt=job.get('negativo'), width=LARG, height=ALT,
                     num_frames=QUADROS, num_inference_steps=total, guidance_scale=GUIA, callback_on_step_end=progresso)
    arq = os.path.join(tempfile.gettempdir(), f"rafa_video_{job['id']}_{os.getpid()}.mp4")
    n_quadros = salva_mp4(saida.frames[0], arq)
    segundos = int(job.get('segundos') or 0)
    if segundos:
        try:
            req('POST', '/api/agente/progresso/' + job['id'], {'texto': f'finalizando o vídeo de {segundos} s'})
        except Exception:
            pass
        final = estica_para(arq, segundos, n_quadros)
        if final != arq:
            try:
                os.remove(arq)
            except Exception:
                pass
            arq = final
    return arq, time.time() - t0


# ---------- FOTO: recorte (BiRefNet) + melhoria (Real-ESRGAN) + luz, com trava de integridade ----------
SEG = None   # ('birefnet', modelo) ou ('u2netp', sessão onnx)
SR = None    # modelo Real-ESRGAN, ou False se não deu pra carregar


def sessao_onnx(arq):
    import onnxruntime as ort
    prov = [p for p in ('DmlExecutionProvider', 'CUDAExecutionProvider') if p in ort.get_available_providers()] + ['CPUExecutionProvider']
    try:
        return ort.InferenceSession(arq, providers=prov)
    except Exception:
        return ort.InferenceSession(arq, providers=['CPUExecutionProvider'])


def carrega_seg():
    global SEG
    if SEG is not None:
        return SEG
    try:
        arq = baixa_arquivo('https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx',
                            os.path.join(PASTA, 'birefnet-lite.onnx'), 'recorte BiRefNet (224 MB)')
        s = sessao_onnx(arq)
        log('Recorte BiRefNet pronto (' + ', '.join(p.replace('ExecutionProvider', '') for p in s.get_providers()) + ').')
        SEG = ('birefnet', s)
    except Exception as e:
        log('BiRefNet indisponível, usando o recorte leve (u2netp):', str(e)[:160])
        arq = os.path.join(PASTA, 'u2netp.onnx')
        if not os.path.exists(arq):
            with open(arq, 'wb') as f:
                f.write(baixa(SERVIDOR + '/ia/u2netp.onnx'))
        SEG = ('u2netp', sessao_onnx(arq))
    return SEG


def mascara(img):
    import numpy as np
    from PIL import Image
    tipo, m = carrega_seg()
    lado = 1024 if tipo == 'birefnet' else 320
    media, desvio = np.array([0.485, 0.456, 0.406], np.float32), np.array([0.229, 0.224, 0.225], np.float32)
    a = np.asarray(img.resize((lado, lado), Image.LANCZOS if tipo == 'birefnet' else Image.BILINEAR), dtype=np.float32)
    a = (a / max(1.0, float(a.max())) - media) / desvio
    out = m.run(None, {m.get_inputs()[0].name: a.transpose(2, 0, 1)[None].astype(np.float32)})[0][0, 0]
    if out.min() < 0 or out.max() > 1:
        out = 1 / (1 + np.exp(-out))
    pred = (out - out.min()) / max(1e-6, float(out.max() - out.min()))
    mk = Image.fromarray((pred * 255).clip(0, 255).astype('uint8')).resize(img.size, Image.BILINEAR)
    return np.asarray(mk, dtype=np.float32) / 255.0, tipo


def carrega_sr():
    global SR
    if SR is not None:
        return SR
    try:
        if CUDA:
            from spandrel import ModelLoader
            arq = baixa_arquivo('https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth',
                                os.path.join(PASTA, 'RealESRGAN_x4plus.pth'), 'melhoria Real-ESRGAN (64 MB)')
            m = ModelLoader().load_from_file(arq)
            m.to('cuda').eval()
            if getattr(m, 'supports_half', False):
                m.half()
            SR = ('cuda', m)
        elif os.name == 'nt':   # AMD/Intel no Windows: versão Vulkan
            pasta = os.path.join(PASTA, 'realesrgan')
            exe = os.path.join(pasta, 'realesrgan-ncnn-vulkan.exe')
            if not os.path.exists(exe):
                z = baixa_arquivo('https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip',
                                  os.path.join(PASTA, 'realesrgan.zip'), 'melhoria Real-ESRGAN Vulkan (45 MB)')
                with zipfile.ZipFile(z) as zz:
                    zz.extractall(pasta)
                for raiz, _, arqs in os.walk(pasta):
                    if 'realesrgan-ncnn-vulkan.exe' in arqs and raiz != pasta:
                        exe = os.path.join(raiz, 'realesrgan-ncnn-vulkan.exe')
            SR = ('vulkan', exe)
        else:
            SR = False
    except Exception as e:
        log('Melhoria Real-ESRGAN indisponível (segue sem ela):', str(e)[:160])
        SR = False
    return SR


def super_resolucao(arr):
    # arr: HxWx3 float32 0..1 -> 4x maior (ou None se não der)
    import numpy as np
    sr = carrega_sr()
    if not sr:
        return None
    if sr[0] == 'vulkan':
        import cv2
        ent = os.path.join(tempfile.gettempdir(), f'rafa_sr_in_{os.getpid()}.png')
        sai = os.path.join(tempfile.gettempdir(), f'rafa_sr_out_{os.getpid()}.png')
        cv2.imwrite(ent, cv2.cvtColor((arr * 255).clip(0, 255).astype('uint8'), cv2.COLOR_RGB2BGR))
        subprocess.run([sr[1], '-i', ent, '-o', sai, '-n', 'realesrgan-x4plus', '-s', '4', '-f', 'png'],
                       check=True, timeout=600, cwd=os.path.dirname(sr[1]), capture_output=True)
        out = cv2.cvtColor(cv2.imread(sai), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        for f in (ent, sai):
            try:
                os.remove(f)
            except Exception:
                pass
        return out
    m = sr[1]
    esc = int(getattr(m, 'scale', 4))
    dt = torch.float16 if getattr(m, 'supports_half', False) else torch.float32
    h, w, _ = arr.shape
    T, ov = 192, 16
    out = np.zeros((h * esc, w * esc, 3), np.float32)
    for y in range(0, h, T):
        for x in range(0, w, T):
            y0, x0, y1, x1 = max(0, y - ov), max(0, x - ov), min(h, y + T + ov), min(w, x + T + ov)
            t = torch.from_numpy(arr[y0:y1, x0:x1].transpose(2, 0, 1).copy())[None].to('cuda', dt)
            with torch.no_grad():
                r = m(t).float().clamp(0, 1).cpu().numpy()[0].transpose(1, 2, 0)
            ye, xe = min(y + T, h), min(x + T, w)
            out[y * esc:ye * esc, x * esc:xe * esc] = r[(y - y0) * esc:(ye - y0) * esc, (x - x0) * esc:(xe - x0) * esc]
    return out


def estrutura_igual(a, b, m):
    # "integridade": quanto a estrutura (contornos, letras, furos) continua igual, ignorando brilho. 0..1
    import cv2
    import numpy as np
    a, b = a.astype(np.float32), b.astype(np.float32)
    g = lambda z: cv2.GaussianBlur(z, (11, 11), 1.5)
    ma, mb = g(a), g(b)
    va, vb, cab = g(a * a) - ma * ma, g(b * b) - mb * mb, g(a * b) - ma * mb
    C3 = ((0.03 * 255) ** 2) / 2
    # só o termo de estrutura do SSIM (correlação local): não muda com brilho nem contraste,
    # só cai se contornos, letras ou furos mudarem de lugar ou de forma
    st = (cab + C3) / (np.sqrt(np.maximum(va, 0) * np.maximum(vb, 0)) + C3)
    sel = m > 0.5
    return float(np.clip(st[sel], 0, 1).mean()) if sel.any() else 1.0


def tons(rgb, alfa, op):
    # luz e cor só na peça, sem mexer em forma nem detalhe
    import cv2
    import numpy as np
    m = alfa > 0.5
    if not m.any():
        return rgb
    if op.get('cor'):
        med = rgb[m].mean(axis=0)
        alvo = med.mean()
        f = 1 + np.clip((alvo / np.maximum(1, med) - 1) * 0.3, -0.06, 0.06)
        rgb = rgb * f
    if op.get('realce', True) is not False:
        lum = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114
        lo, hi = np.percentile(lum[m], 2), np.percentile(lum[m], 98)
        g = min(1.6, max(1.0, 225 / max(1, hi - lo))) * float(op.get('contraste', 1))
        off = max(0, 18 - lo * g) + float(op.get('claro', 0))
        rgb = (rgb - lo) * g + lo + off
        lab = cv2.cvtColor(np.clip(rgb, 0, 255).astype(np.uint8), cv2.COLOR_RGB2LAB)
        L = lab[..., 0]
        cl = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8)).apply(L)   # clareia as partes escuras da peça
        lab[..., 0] = np.where(m, (0.5 * L + 0.5 * cl), L).astype(np.uint8)
        rgb = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB).astype(np.float32)
    if op.get('reflexos'):
        lum = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114
        f = np.where((lum > 222) & m, (222 + (lum - 222) * 0.35) / np.maximum(lum, 1), 1.0)
        rgb = rgb * f[..., None]
    return np.clip(rgb, 0, 255)


def processa_foto(job):
    import cv2
    import numpy as np
    from PIL import Image, ImageOps
    op = job.get('opcoes') or {}
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(baixa(job['foto_url'])))).convert('RGB')
    try:
        req('POST', '/api/agente/progresso/' + job['id'], {'texto': 'recortando a peça'})
    except Exception:
        pass
    alfa, seg_nome = mascara(img)
    corte = float(op.get('corte', 0.2))
    alfa = np.clip((alfa - corte) / 0.5, 0, 1)
    ys, xs = np.where(alfa > 0.5)
    if len(ys) < alfa.size * 0.01:
        raise RuntimeError('a IA não encontrou a peça nessa foto')
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    rgb = np.asarray(img, dtype=np.float32)[y0:y1, x0:x1]
    a = alfa[y0:y1, x0:x1]
    original = rgb.copy()
    giro = int(op.get('girar', 0)) % 360
    if op.get('espelhar'):
        rgb, a, original = rgb[:, ::-1], a[:, ::-1], original[:, ::-1]
    if giro in (90, 180, 270):
        k = {90: 3, 180: 2, 270: 1}[giro]
        rgb, a, original = np.rot90(rgb, k), np.rot90(a, k), np.rot90(original, k)
    rgb, a, original = np.ascontiguousarray(rgb), np.ascontiguousarray(a), np.ascontiguousarray(original)
    try:
        req('POST', '/api/agente/progresso/' + job['id'], {'texto': 'melhorando a qualidade e a luz'})
    except Exception:
        pass
    rgb = tons(rgb, a, op)
    h, w = a.shape
    T = 1200
    oc = float(op.get('ocupa', 0.84))
    s = min(T * oc / w, T * oc / h)
    dw, dh = max(1, int(round(w * s))), max(1, int(round(h * s)))
    etapas = ['recorte ' + ('BiRefNet' if seg_nome == 'birefnet' else 'leve')]
    base = None
    if s > 1.15:   # foto pequena: aumenta com IA, se a estrutura continuar igual
        try:
            sr = super_resolucao(rgb / 255.0)
            if sr is not None:
                volta = cv2.resize(sr * 255.0, (w, h), interpolation=cv2.INTER_AREA)
                cinza = lambda z: cv2.cvtColor(np.clip(z, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
                integ = estrutura_igual(cinza(rgb), cinza(volta), a)
                if integ >= 0.85:
                    base = cv2.resize(sr * 255.0, (dw, dh), interpolation=cv2.INTER_AREA)
                    etapas.append(f'Real-ESRGAN (aprovado {integ * 100:.0f}%)')
                else:
                    etapas.append(f'Real-ESRGAN recusado (mudaria a peça: {integ * 100:.0f}%)')
        except Exception as e:
            etapas.append('sem Real-ESRGAN (' + str(e)[:60] + ')')
    if base is None:
        base = cv2.resize(rgb, (dw, dh), interpolation=cv2.INTER_LANCZOS4 if s > 1 else cv2.INTER_AREA)
        if op.get('ruido'):
            base = cv2.fastNlMeansDenoisingColored(np.clip(base, 0, 255).astype(np.uint8), None, 3, 3, 7, 21).astype(np.float32)
    if op.get('nitidez'):
        blur = cv2.GaussianBlur(base, (0, 0), 1.0)
        base = base + 0.5 * (base - blur)
    base = np.clip(base, 0, 255)
    am = cv2.resize(a, (dw, dh), interpolation=cv2.INTER_LINEAR)
    am = cv2.GaussianBlur(am, (3, 3), 0)[..., None]
    fundo = op.get('fundo') or '#ffffff'
    cor = np.array([int(fundo[i:i + 2], 16) for i in (1, 3, 5)], np.float32)
    tela = np.ones((T, T, 3), np.float32) * cor
    px, py = (T - dw) // 2, (T - dh) // 2
    if op.get('sombra'):
        sombra = np.zeros((T, T), np.float32)
        cv2.ellipse(sombra, (T // 2, py + int(dh * 0.985)), (int(dw * 0.45), max(4, int(dh * 0.05))), 0, 0, 360, 1.0, -1)
        sombra = cv2.GaussianBlur(sombra, (0, 0), 18) * 0.25
        tela = tela * (1 - sombra[..., None])
    reg = tela[py:py + dh, px:px + dw]
    tela[py:py + dh, px:px + dw] = reg * (1 - am) + base * am
    # integridade final (estrutura da peça pronta x original), sem contar brilho
    cinza = lambda z: cv2.cvtColor(np.clip(z, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    final_peq = cv2.resize(base, (w, h), interpolation=cv2.INTER_AREA)
    integ = estrutura_igual(cinza(original), cinza(final_peq), a)
    etapas.append('luz e cor ajustadas')
    etapas.append(f'integridade {integ * 100:.0f}%')
    buf = io.BytesIO()
    Image.fromarray(np.clip(tela, 0, 255).astype(np.uint8)).save(buf, 'JPEG', quality=93)
    return buf.getvalue(), ' · '.join(etapas)


def video_cinema(job):
    # câmera se aproximando devagar + luz de estúdio passando; a peça é a foto real e não muda
    import cv2
    import numpy as np
    from PIL import Image, ImageOps
    import imageio
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(baixa(job['foto_url'])))).convert('RGB')
    try:
        req('POST', '/api/agente/progresso/' + job['id'], {'texto': 'recortando a peça'})
    except Exception:
        pass
    alfa, _ = mascara(img)
    alfa = np.clip((alfa - 0.2) / 0.5, 0, 1)
    ys, xs = np.where(alfa > 0.5)
    if len(ys) < alfa.size * 0.01:
        raise RuntimeError('a IA não encontrou a peça nessa foto')
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    rgb = np.asarray(img, dtype=np.float32)[y0:y1, x0:x1]
    a = alfa[y0:y1, x0:x1]
    if not job.get('foto_ia'):
        rgb = tons(rgb, a, {})
    W, H, N, FPS_V, SS = 1080, 1920, 300, 30, 1.12   # cena feita 12% maior pra aproximar sem perder nitidez
    BW, BH = int(W * SS), int(H * SS)
    yy, xx = np.mgrid[0:BH, 0:BW].astype(np.float32)
    d = np.sqrt(((xx - BW / 2) / (BW * 0.7)) ** 2 + ((yy - BH * 0.47) / (BH * 0.62)) ** 2)
    f = 255 - 40 * np.clip(d, 0, 1.4) ** 1.6
    cena = np.dstack([f, f * 0.988, f * 0.968])                     # fundo de estúdio, levemente quente
    h, w = a.shape
    s = min(BW * 0.84 / w, BH * 0.52 / h)
    dw, dh = int(w * s), int(h * s)
    peca = cv2.resize(rgb, (dw, dh), interpolation=cv2.INTER_LANCZOS4 if s > 1 else cv2.INTER_AREA)
    am = cv2.GaussianBlur(cv2.resize(a, (dw, dh), interpolation=cv2.INTER_LINEAR), (3, 3), 0)
    px, py = (BW - dw) // 2, int(BH * 0.47 - dh / 2)
    sombra = np.zeros((BH, BW), np.float32)                           # sombra natural embaixo da peça
    cv2.ellipse(sombra, (BW // 2, py + int(dh * 0.98)), (int(dw * 0.42), max(6, int(dh * 0.05))), 0, 0, 360, 1.0, -1)
    sombra = cv2.GaussianBlur(sombra, (0, 0), 28) * 0.28
    cena = cena * (1 - sombra[..., None])
    reg = cena[py:py + dh, px:px + dw]
    cena[py:py + dh, px:px + dw] = reg * (1 - am[..., None]) + np.clip(peca, 0, 255) * am[..., None]
    mascara_cena = np.zeros((BH, BW), np.float32)
    mascara_cena[py:py + dh, px:px + dw] = am
    vinheta = (1 - 0.10 * np.clip(d, 0, 1.4) ** 2)[..., None]
    arq = os.path.join(tempfile.gettempdir(), f"rafa_video_{job['id']}_{os.getpid()}.mp4")
    try:
        req('POST', '/api/agente/progresso/' + job['id'], {'texto': 'filmando (câmera e luz)'})
    except Exception:
        pass
    diag = (xx * 0.8 + yy * 0.6)
    dmin, dmax = float(diag[mascara_cena > 0.5].min()), float(diag[mascara_cena > 0.5].max())
    with imageio.get_writer(arq, fps=FPS_V, codec='libx264', quality=8, pixelformat='yuv420p', macro_block_size=8) as wr:
        for i in range(N):
            t = i / (N - 1)
            e = t * t * (3 - 2 * t)                                    # começa e termina suave
            zoom = 1.0 + 0.075 * e                                     # aproximação lenta
            pos = dmin - 0.25 * (dmax - dmin) + 1.5 * (dmax - dmin) * t  # faixa de luz atravessando a peça
            faixa = np.exp(-((diag - pos) / (0.10 * (dmax - dmin) + 1)) ** 2) * 0.16 * mascara_cena
            quadro = cena + faixa[..., None] * (255 - cena)
            quadro = quadro * (1 + 0.015 * np.sin(2 * np.pi * t)) * vinheta   # luz "respirando" bem de leve
            cw, ch = BW / zoom, BH / zoom
            x0c = min(max(BW / 2 - cw / 2, 0), BW - cw)            # recorte da câmera sempre dentro da cena,
            y0c = min(max(BH * 0.47 - ch / 2, 0), BH - ch)         # mirando a peça
            M = np.array([[W / cw, 0, -x0c * W / cw], [0, H / ch, -y0c * H / ch]], np.float32)
            fr = cv2.warpAffine(np.clip(quadro, 0, 255).astype(np.float32), M, (W, H), flags=cv2.INTER_AREA if zoom < 1.12 else cv2.INTER_CUBIC)
            wr.append_data(np.clip(fr, 0, 255).astype(np.uint8))
            if i % 60 == 0:
                try:
                    req('POST', '/api/agente/progresso/' + job['id'], {'texto': f'filmando: {i * 100 // N}%'})
                except Exception:
                    pass
    return arq


def main():
    log(f'Gerador de vídeo Rafa Busca Peças v{VERSAO}')
    log(f'Placa: {GPU}' + (f' ({VRAM:.0f} GB)' if VRAM else '') + ' — vídeo: ' + {'wan': 'IA Wan 2.2', 'ltx': 'IA LTX-Video', 'cinema': 'cinematográfico com a foto real'}[MODELO])
    log('Deixe esta janela aberta. Os pedidos de vídeo feitos no sistema aparecem aqui.')
    info = {'gpu': GPU, 'vram': round(VRAM, 1), 'modelo': MODELO, 'versao': VERSAO}
    while True:
        try:
            r = req('POST', '/api/agente/proximo', info, timeout=30)
            job = r.get('job') if isinstance(r, dict) else None
            if not job:
                time.sleep(8)
                continue
            if job.get('tipo') == 'foto':
                log('Nova foto para melhorar:', job['id'])
                try:
                    t0 = time.time()
                    dados, detalhe = processa_foto(job)
                    req('POST', '/api/agente/video/' + job['id'] + '?detalhe=' + urllib.parse.quote(detalhe), dados, tipo='image/jpeg', timeout=120)
                    log(f'Foto pronta ({time.time() - t0:.0f} s): {detalhe}')
                except Exception as e:
                    traceback.print_exc()
                    try:
                        req('POST', '/api/agente/erro/' + job['id'], {'erro': f'{type(e).__name__}: {e}'[:480]})
                    except Exception:
                        pass
                continue
            log('Novo pedido de vídeo:', job['id'])
            try:
                arq, seg = gera(job)
                with open(arq, 'rb') as f:
                    dados = f.read()
                req('POST', '/api/agente/video/' + job['id'], dados, tipo='video/mp4', extra={'X-Modelo': MODELO}, timeout=300)
                log(f'Vídeo pronto e enviado ({seg / 60:.1f} min).')
                try:
                    os.remove(arq)
                except Exception:
                    pass
            except Exception as e:
                traceback.print_exc()
                msg = f'{type(e).__name__}: {e}'
                if 'out of memory' in str(e).lower():
                    msg = 'a placa de vídeo ficou sem memória. Feche jogos e programas pesados e tente de novo.'
                try:
                    req('POST', '/api/agente/erro/' + job['id'], {'erro': msg[:480]})
                except Exception:
                    pass
            finally:
                try:
                    if CUDA:
                        torch.cuda.empty_cache()
                except Exception:
                    pass
        except urllib.error.HTTPError as e:
            if e.code == 401:
                log('A chave deste gerador não vale mais. Baixe o instalador de novo no sistema.')
                time.sleep(60)
            else:
                log('O sistema respondeu com erro', e.code, '— tentando de novo...')
                time.sleep(15)
        except Exception as e:
            log('Sem conexão com o sistema, tentando de novo...', e)
            time.sleep(15)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log('Gerador fechado.')
