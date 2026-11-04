import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const BASE_DIR = './docs/captura-driveparts';
const ASSETS_DIR = join(BASE_DIR, 'assets');
const API_DIR = join(BASE_DIR, 'api-responses');
const SCREENSHOTS_DIR = join(BASE_DIR, 'screenshots');

// Cria estrutura de pastas
[BASE_DIR, ASSETS_DIR, API_DIR, SCREENSHOTS_DIR].forEach(dir => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

const apiCalls = [];
const resources = [];

(async () => {
  console.log('🚀 Iniciando varredura completa do sistema Driveparts...\n');
  
  const browser = await chromium.launch({ 
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1440, height: 900 }
  });
  
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  // Intercepta requisições de API
  page.on('response', async (response) => {
    const url = response.url();
    const type = response.request().resourceType();
    
    if (type === 'xhr' || type === 'fetch') {
      try {
        const json = await response.json();
        apiCalls.push({ url, method: response.request().method(), status: response.status(), data: json });
        console.log(`📡 API: ${response.request().method()} ${url}`);
      } catch (e) {}
    }
    
    if (['image', 'stylesheet', 'script', 'font'].includes(type)) {
      resources.push({ url, type, status: response.status() });
    }
  });

  // ETAPA 1: Capturar tela de login
  console.log('\n📋 ETAPA 1: Acessando página de login...');
  await page.goto('https://driveparts.com.br/sistema/parts-home', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  
  const loginHTML = await page.content();
  writeFileSync(join(BASE_DIR, '01-login-page.html'), loginHTML);
  await page.screenshot({ path: join(SCREENSHOTS_DIR, '01-login.png'), fullPage: true });
  console.log('✅ Tela de login capturada');

  // ETAPA 2: Realizar login (manual ou automático)
  console.log('\n🔐 ETAPA 2: Tentando login automático...');
  
  const selectors = [
    { u: '#username', p: '#password', b: 'button[type="submit"]' },
    { u: 'input[name="username"]', p: 'input[name="password"]', b: 'button[type="submit"]' },
    { u: 'input[type="text"]', p: 'input[type="password"]', b: 'button' }
  ];

  let logged = false;
  for (const s of selectors) {
    try {
      const userInput = await page.$(s.u);
      const passInput = await page.$(s.p);
      const btn = await page.$(s.b);
      
      if (userInput && passInput && btn) {
        await userInput.fill('BUSCAPECAS');
        await passInput.fill('37903');
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {}),
          btn.click()
        ]);
        await page.waitForTimeout(3000);
        logged = true;
        console.log('✅ Login automático realizado');
        break;
      }
    } catch (e) {}
  }

  if (!logged) {
    console.log('⚠️  Login automático falhou. FAÇA LOGIN MANUALMENTE no navegador aberto.');
    console.log('⏸️  Pressione ENTER aqui após fazer login...');
    await new Promise(resolve => process.stdin.once('data', () => resolve()));
    console.log('▶️  Continuando...');
  }

  const cookies = await context.cookies();
  writeFileSync(join(BASE_DIR, 'session-cookies.json'), JSON.stringify(cookies, null, 2));
  console.log('🍪 Cookies salvos');


  // ETAPA 3: Capturar dashboard principal
  console.log('\n🏠 ETAPA 3: Capturando dashboard...');
  await page.waitForTimeout(2000);
  const mainHTML = await page.content();
  writeFileSync(join(BASE_DIR, '02-dashboard.html'), mainHTML);
  await page.screenshot({ path: join(SCREENSHOTS_DIR, '02-dashboard.png'), fullPage: true });
  console.log('✅ Dashboard capturado');

  // Captura menu/navegação
  const menuItems = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('a, button[data-route]').forEach(el => {
      const text = el.textContent.trim();
      const href = el.getAttribute('href');
      if (text || href) items.push({ text, href, classes: el.className });
    });
    return items;
  });
  writeFileSync(join(BASE_DIR, 'menu-items.json'), JSON.stringify(menuItems, null, 2));
  console.log(`📋 ${menuItems.length} itens de menu encontrados`);

  // ETAPA 4: Tentar capturar rotas comuns
  console.log('\n🔍 ETAPA 4: Varrendo rotas...');
  const routes = ['/estoque', '/pecas', '/vendas', '/cadastro', '/relatorios', '/config'];
  for (const route of routes) {
    try {
      const url = new URL(page.url()).origin + route;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(1000);
      const html = await page.content();
      const name = route.replace(/\//g, '-') || 'root';
      writeFileSync(join(BASE_DIR, `03-route${name}.html`), html);
      console.log(`✅ Rota ${route} capturada`);
    } catch (e) {
      console.log(`⚠️  Rota ${route} não existe`);
    }
  }

  // ETAPA 5: Versão mobile
  console.log('\n📱 ETAPA 5: Capturando versão mobile...');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(SCREENSHOTS_DIR, '04-mobile.png'), fullPage: true });
  const mobileHTML = await page.content();
  writeFileSync(join(BASE_DIR, '04-mobile.html'), mobileHTML);
  console.log('✅ Versão mobile capturada');

  // ETAPA 6: Extrair estilos CSS
  console.log('\n🎨 ETAPA 6: Extraindo CSS...');
  const styles = await page.evaluate(() => {
    const css = { inline: [], animations: [], vars: {} };
    document.querySelectorAll('style').forEach(s => css.inline.push(s.textContent));
    
    const root = getComputedStyle(document.documentElement);
    for (let i = 0; i < root.length; i++) {
      const prop = root[i];
      if (prop.startsWith('--')) css.vars[prop] = root.getPropertyValue(prop).trim();
    }
    return css;
  });
  writeFileSync(join(BASE_DIR, '05-styles.json'), JSON.stringify(styles, null, 2));
  console.log('✅ CSS extraído');

  // Salvar APIs e recursos
  writeFileSync(join(API_DIR, 'all-apis.json'), JSON.stringify(apiCalls, null, 2));
  writeFileSync(join(BASE_DIR, 'resources.json'), JSON.stringify(resources, null, 2));
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ VARREDURA COMPLETA!');
  console.log(`📁 Arquivos em: ${BASE_DIR}`);
  console.log(`📡 ${apiCalls.length} APIs interceptadas`);
  console.log(`📦 ${resources.length} recursos encontrados`);
  console.log('='.repeat(60));

  await browser.close();
  process.exit(0);
})();

