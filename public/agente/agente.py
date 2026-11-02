# -*- coding: utf-8 -*-
"""
Gerador de vídeo com IA — Rafa Busca Peças
Roda no PC com placa NVIDIA. Busca os pedidos de vídeo no sistema, gera o
vídeo com um modelo aberto (Wan 2.2, Apache-2.0; ou LTX-Video nas placas com
menos memória) e devolve o MP4. Não precisa abrir porta no roteador: é o PC
que chama o sistema.
"""
import io, json, os, sys, tempfile, time, traceback, urllib.error, urllib.request

VERSAO = '1.1'
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


try:
    import torch
except Exception:
    log('ERRO: a IA não foi instalada direito. Rode o instalador de novo.')
    input('Aperte Enter para sair...')
    sys.exit(1)

if not torch.cuda.is_available():
    log('ERRO: não achei placa NVIDIA com CUDA. Atualize o driver da NVIDIA e rode o instalador de novo.')
    input('Aperte Enter para sair...')
    sys.exit(1)

GPU = torch.cuda.get_device_name(0)
VRAM = torch.cuda.get_device_properties(0).total_memory / 1024 ** 3
MODELO = CFG.get('modelo', 'auto')
if MODELO not in ('wan', 'ltx'):
    MODELO = 'wan' if VRAM >= 20 else 'ltx'

# tamanho do vídeo (vertical 9:16, bom pra Clips/Reels) e ajustes por modelo
if MODELO == 'wan':
    LARG, ALT, QUADROS, FPS, GUIA = 704, 1280, 121, 24, 5.0   # 5 s
else:
    LARG, ALT, QUADROS, FPS, GUIA = 480, 832, 121, 24, 3.0    # 5 s

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


def main():
    log(f'Gerador de vídeo Rafa Busca Peças v{VERSAO}')
    log(f'Placa: {GPU} ({VRAM:.0f} GB) — modelo: {"Wan 2.2" if MODELO == "wan" else "LTX-Video"}')
    log('Deixe esta janela aberta. Os pedidos de vídeo feitos no sistema aparecem aqui.')
    info = {'gpu': GPU, 'vram': round(VRAM, 1), 'modelo': MODELO, 'versao': VERSAO}
    while True:
        try:
            r = req('POST', '/api/agente/proximo', info, timeout=30)
            job = r.get('job') if isinstance(r, dict) else None
            if not job:
                time.sleep(8)
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
