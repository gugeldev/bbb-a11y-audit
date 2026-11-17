import { devices, Page as PlaywrightPage } from '@playwright/test';

import { ELEMENT_WAIT_EXTRA_LONG_TIME, ELEMENT_WAIT_LONGER_TIME } from '../core/constants';
import { elements as e } from '../core/elements';
import { Page } from '../core/page';
import { test } from '../core/setup/fixtures';
import { answerPollOption, openPoll, startPoll } from '../polling/util';
import { startScreenshare } from '../screenshare/util';
import { MultiUsers } from '../user/multiusers';
import { openLockViewers, openUserListIfClosed } from '../user/util';
import { findNonTextContrastViolations } from './nonTextContrast';
import {
  auditOutDir,
  AuditRecorder,
  checkFocusReturn,
  checkHoverFocus,
  checkKeyboard,
  checkMenuSelection,
  checkReflow,
  checkStateChange,
  checkTextSpacing,
  clearAnnouncements,
  ensureAnnouncementRecorder,
  installAnnouncementRecorder,
  wants,
} from './wcagAuditRecorder';

/**
 * WCAG 2.2 AA runtime audit used by the bbb-a11y-audit agent skill.
 *
 * This is an audit, not a regression test: it never fails because of violations. Each test is one
 * scenario (moderator tour, multi-user interactions, guest lobby, locale, dark theme, mobile) and
 * writes <A11Y_AUDIT_DIR>/<scenario>.json plus screenshots. Not tagged @ci, so it never runs in CI.
 *
 *   A11Y_AUDIT_DIR=/abs/dir npx playwright test accessibility/wcagAudit.spec.ts --project=chromium --workers=1
 */

const TIMEOUT = 15 * 60 * 1000;
const ACCEPT_GUEST = '[data-test="acceptGuest"]';
const PRIVATE_MESSAGE_GUEST = '[data-test="privateMessageGuest"]';
const PRIVATE_LOBBY_MESSAGE = '[data-test="privateLobbyMessage"]';
const esc = (page: PlaywrightPage) => page.keyboard.press('Escape');

async function openPublicChatPanel(p: Page) {
  if (!(await p.page.locator(e.hidePublicChat).isVisible())) {
    // Mobile layout: the sidebar navigation is collapsed behind a toggle button.
    const toggle = p.page.locator(e.toggleSidebarNavigation).first();
    if (await toggle.isVisible()) {
      await toggle.click();
      await p.page.waitForTimeout(1500);
    }
    await p.page.locator(e.messagesSidebarButton).first().click();
    await p.page.waitForTimeout(1000);
    if (
      !(await p.page.locator(e.hidePublicChat).isVisible()) &&
      (await p.page.locator(e.chatButton).first().isVisible())
    ) {
      await p.page.locator(e.chatButton).first().click();
    }
  }
  await p.hasElement(e.hidePublicChat, 'should display the public chat');
}

async function sendChatMessage(p: Page, text: string) {
  await p.page.locator(e.chatBox).fill(text);
  await p.waitAndClick(e.sendButton);
}

async function standardChecks(rec: AuditRecorder, page: PlaywrightPage, prefix = '') {
  await rec.check(`${prefix}keyboard`, () => checkKeyboard(page), ['2.1', '2.4']);
  await rec.check(`${prefix}reflow`, () => checkReflow(page), ['1.4']);
  await rec.check(`${prefix}textSpacing`, () => checkTextSpacing(page), ['1.4']);
  await rec.check(`${prefix}nonTextContrast`, () => findNonTextContrastViolations(page), ['1.4']);
}

test.describe('WCAG audit', { tag: '@a11y-audit' }, () => {
  test('moderator: full tour of the meeting UI', async ({ browser, context, page }, testInfo) => {
    test.setTimeout(TIMEOUT);
    const rec = new AuditRecorder(
      {
        id: 'moderator',
        name: 'Moderador sozinho na sala',
        description:
          'Um moderador entra, conecta o áudio e percorre todos os painéis, menus e modais disponíveis para ele: lista de usuários, chat, configurações, enquete, breakout, notas, timer, reações, webcam, compartilhamento de tela, quadro branco e saída da reunião.',
        actors: ['moderator'],
      },
      auditOutDir(testInfo.outputPath('a11y-audit')),
    );
    try {
      await installAnnouncementRecorder(context);
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo, shouldCloseAudioModal: false });
      // Which server and client build was audited (shown in the report).
      const clientVersion = await mod.page.evaluate(() => {
        // @ts-ignore - injected on window by the client at runtime
        const app = window.meetingClientSettings?.public?.app || {};
        return { bbbServerVersion: app.bbbServerVersion || null, html5ClientBuild: app.html5ClientBuild || null };
      });
      rec.note('server', { url: (process.env.BBB_URL || '').replace(/\/bigbluebutton\/?$/, ''), ...clientVersion });
      const p = mod.page;

      await rec.state(
        p,
        'audio-modal',
        'Modal de áudio',
        'Primeira tela após entrar: escolha de como participar do áudio.',
        {
          enter: () => mod.hasElement(e.audioModal, 'audio modal'),
        },
      );
      await rec.state(p, 'audio-echo-test', 'Teste de eco', 'Etapa em que a pessoa confirma se está se ouvindo.', {
        enter: async () => {
          await mod.clickMicrophoneButton();
          await mod.waitForSelector(e.stopHearingButton);
        },
      });
      await rec.state(
        p,
        'meeting',
        'Sala com áudio conectado',
        'Estado principal da reunião, microfone conectado e mutado.',
        {
          enter: async () => {
            await mod.waitAndClick(e.joinEchoTestButton);
            await mod.hasElement(e.unmuteMicButton, 'should be in audio');
          },
        },
      );
      await standardChecks(rec, p);
      await rec.check(
        'focusReturn',
        async () => {
          const results = [];
          for (const trigger of [
            e.audioDropdownMenu,
            e.mediaAreaButton,
            e.optionsButton,
            e.leaveMeetingDropdown,
            e.settingsSidebarButton,
          ]) {
            results.push(await checkFocusReturn(p, trigger));
          }
          return results;
        },
        ['2.4', '2.1', '3.2'],
      );
      await rec.check(
        'hoverFocus',
        () =>
          checkHoverFocus(p, [
            e.joinVideo,
            e.unmuteMicButton,
            e.raiseHandBtn,
            e.reactionsButton,
            e.mediaAreaButton,
            e.leaveMeetingDropdown,
            e.connectionStatusBtn,
            e.settingsSidebarButton,
            e.usersListSidebarButton,
          ]),
        ['1.4'],
      );
      await rec.check(
        'stateChanges',
        async () => {
          const out = [];
          out.push(await checkStateChange(p, e.unmuteMicButton, 'click'));
          out.push(await checkStateChange(p, e.raiseHandBtn, 'click'));
          for (const trigger of [
            e.audioDropdownMenu,
            e.mediaAreaButton,
            e.optionsButton,
            e.leaveMeetingDropdown,
            e.reactionsButton,
          ]) {
            out.push(await checkStateChange(p, trigger, 'escape'));
          }
          return out;
        },
        ['4.1', '1.3'],
      );
      await rec.check(
        'deviceSelection',
        async () => [
          await checkMenuSelection(p, e.audioDropdownMenu, '[id^="audioinput-"]'),
          await checkMenuSelection(p, e.audioDropdownMenu, '[id^="audiooutput-"]'),
        ],
        ['4.1', '1.3'],
      );
      await rec.state(p, 'audio-menu', 'Menu de áudio', 'Menu de dispositivos e saída do áudio.', {
        enter: () => mod.waitAndClick(e.audioDropdownMenu),
        leave: () => esc(p),
      });
      await rec.state(p, 'user-list', 'Lista de usuários', 'Painel de participantes.', {
        enter: () => openUserListIfClosed(mod),
      });
      await rec.check('keyboard-user-list', () => checkKeyboard(p, 60), ['2.1', '2.4']);
      await rec.state(
        p,
        'user-item-menu',
        'Menu de um participante',
        'Menu aberto ao clicar no próprio nome na lista.',
        {
          enter: () => mod.waitAndClick(e.currentUser),
          leave: () => esc(p),
        },
      );
      await rec.state(p, 'lock-viewers', 'Travar participantes', 'Modal de bloqueio de recursos dos participantes.', {
        enter: () => openLockViewers(mod),
      });
      await rec.state(p, 'guest-policy', 'Política de convidados', 'Aba de política de convidados no mesmo modal.', {
        enter: () => mod.waitAndClick(e.guestPolicyTab),
        leave: () => esc(p),
      });
      await rec.state(p, 'public-chat', 'Chat público', 'Painel de chat público aberto.', {
        enter: async () => {
          await openPublicChatPanel(mod);
          await sendChatMessage(mod, 'Mensagem de teste da auditoria');
        },
      });
      await rec.check('keyboard-public-chat', () => checkKeyboard(p, 60), ['2.1', '2.4']);
      await rec.state(p, 'chat-options', 'Opções do chat', 'Menu de opções do chat (salvar, copiar, limpar).', {
        enter: () => mod.waitAndClick(e.chatOptions),
        leave: () => esc(p),
      });
      await rec.state(p, 'settings', 'Configurações', 'Modal de configurações, aba inicial.', {
        enter: () => mod.waitAndClick(e.settingsSidebarButton),
      });
      // Inside an open modal: focus must stay in the dialog (and not escape to the page behind it).
      await rec.check('keyboard-settings-modal', () => checkKeyboard(p, 40), ['2.1', '2.4']);
      await rec.state(p, 'settings-shortcuts', 'Atalhos de teclado', 'Aba de atalhos dentro das configurações.', {
        enter: () => mod.waitAndClick(e.shortcutsTab),
        leave: () => mod.waitAndClick(e.saveSettingsButton),
      });
      await rec.state(p, 'poll-create', 'Criar enquete', 'Painel de criação de enquete com alternativas.', {
        enter: () => openPoll(mod),
      });
      await rec.state(p, 'poll-running', 'Enquete em andamento', 'Visão do moderador com a enquete iniciada.', {
        enter: () => mod.waitAndClick(e.startPoll),
        leave: async () => {
          await mod.waitAndClick(e.publishPollingLabel);
          await mod.closeAllToastNotifications();
        },
      });
      await rec.state(p, 'breakout', 'Salas de apoio', 'Painel de criação de salas de apoio (breakout).', {
        enter: () => mod.waitAndClick(e.breakoutRoomSidebarButton),
        leave: () => mod.waitAndClick(e.breakoutRoomSidebarButton),
      });
      await rec.state(p, 'shared-notes', 'Notas compartilhadas', 'Editor de notas compartilhadas.', {
        enter: async () => {
          await mod.waitAndClick(e.sharedNotesSidebarButton);
          await mod.hasElement(e.sharedNotesBackground, 'should display shared notes');
        },
        leave: () => mod.waitAndClick(e.sharedNotesSidebarButton),
      });
      await rec.state(p, 'timer', 'Timer e cronômetro', 'Painel de timer.', {
        enter: () => mod.waitAndClick(e.timerStopwatchFeature),
        leave: () => mod.waitAndClick(e.timerStopwatchFeature),
      });
      await rec.state(p, 'reactions', 'Reações', 'Barra de reações aberta.', {
        enter: () => mod.waitAndClick(e.reactionsButton),
        leave: () => esc(p),
      });
      await rec.state(p, 'raise-hand', 'Mão levantada', 'Estado com a mão levantada.', {
        enter: () => mod.waitAndClick(e.raiseHandBtn),
        leave: () => mod.waitAndClick(e.raiseHandBtn),
      });
      await rec.state(
        p,
        'media-area-menu',
        'Menu da área de mídia',
        'Menu de compartilhamento (apresentação, vídeo externo, etc.).',
        {
          enter: () => mod.waitAndClick(e.mediaAreaButton),
          leave: () => esc(p),
        },
      );
      await rec.state(
        p,
        'presentation-upload',
        'Enviar apresentação',
        'Modal de gerenciamento e upload de apresentações.',
        {
          enter: async () => {
            await mod.waitAndClick(e.mediaAreaButton);
            await mod.waitAndClick(e.managePresentations);
          },
          leave: () => esc(p),
        },
      );
      await rec.state(
        p,
        'whiteboard-toolbar',
        'Ferramentas do quadro branco',
        'Barra de ferramentas do quadro branco (presenter).',
        {
          enter: () => mod.hasElement(e.wbToolbar, 'should display the whiteboard toolbar'),
        },
      );
      await rec.state(p, 'whiteboard-menu', 'Menu do quadro branco', 'Menu principal do quadro branco.', {
        enter: () => mod.waitAndClick(e.wbOptions),
        leave: () => esc(p),
      });
      await rec.state(p, 'webcam-preview', 'Prévia da webcam', 'Modal de prévia e configuração da câmera.', {
        enter: async () => {
          await mod.waitAndClick(e.joinVideo);
          await mod.hasElement(e.startSharingWebcam, 'should display the webcam preview');
        },
      });
      await rec.state(p, 'webcam-on', 'Webcam compartilhada', 'Sala com a câmera do moderador ligada.', {
        enter: async () => {
          await mod.waitAndClick(e.startSharingWebcam);
          await mod.hasElement(e.leaveVideo, 'should share the webcam');
        },
      });
      await rec.state(p, 'webcam-menu', 'Menu do vídeo', 'Menu de opções sobre o vídeo de um participante.', {
        enter: () => mod.waitAndClick(e.dropdownWebcamButton),
        leave: async () => {
          await esc(p);
          await mod.waitAndClick(e.leaveVideo);
        },
      });
      await rec.state(p, 'screenshare', 'Compartilhando a tela', 'Sala com compartilhamento de tela ativo.', {
        enter: () => startScreenshare(mod),
        leave: () => mod.waitAndClick(e.stopScreenSharing),
      });
      await rec.state(p, 'session-details', 'Detalhes da sessão', 'Modal com informações da reunião.', {
        enter: () => mod.waitAndClick(e.sessionDetailsButton),
        leave: () => esc(p),
      });
      await rec.state(p, 'connection-status', 'Status da conexão', 'Modal de status da conexão.', {
        enter: () => mod.waitAndClick(e.connectionStatusBtn),
        leave: () => esc(p),
      });
      await rec.state(p, 'options-menu', 'Menu de opções', 'Menu geral (tela cheia, sobre, sair...).', {
        enter: () => mod.waitAndClick(e.optionsButton),
        leave: () => esc(p),
      });
      await rec.state(p, 'leave-menu', 'Menu de sair', 'Menu do botão de saída da reunião.', {
        enter: () => mod.waitAndClick(e.leaveMeetingDropdown),
      });
      await rec.state(
        p,
        'end-meeting',
        'Confirmar encerramento',
        'Modal de confirmação para encerrar a reunião para todos.',
        {
          enter: () => mod.waitAndClick(e.endMeetingButton),
          leave: () => esc(p),
        },
      );
      await rec.collectAnnouncements(p, 'moderador');
    } catch (err) {
      rec.note('scenarioError', String(err).split('\n').slice(0, 2).join(' ').slice(0, 500));
    } finally {
      rec.write();
    }
  });

  test('interactions: moderator and attendee', async ({ browser, context, page }, testInfo) => {
    test.setTimeout(TIMEOUT);
    const rec = new AuditRecorder(
      {
        id: 'interactions',
        name: 'Moderador e participante interagindo',
        description:
          'Duas pessoas na mesma sala. O participante entra, manda mensagens no chat (com o chat do moderador aberto e depois fechado), levanta a mão, responde uma enquete e recebe uma mensagem privada. Grava o que seria anunciado ao leitor de tela de cada um e audita as telas do participante.',
        actors: ['attendee', 'moderator'],
      },
      auditOutDir(testInfo.outputPath('a11y-audit')),
    );
    try {
      await installAnnouncementRecorder(context);
      const users = new MultiUsers(browser, context);
      await users.initModPage(page, { testInfo });
      const mod = users.modPage;
      await openPublicChatPanel(mod);
      await clearAnnouncements(mod.page);
      rec.note('announcementsDiscarded', 'logs before the attendee joined are not kept');
      await users.initUserPage(context, { testInfo });
      const att = users.userPage;
      await att.page.waitForTimeout(2000);
      await rec.collectAnnouncements(mod.page, 'moderador: participante entrou na sala');

      await rec.state(
        att.page,
        'attendee-meeting',
        'Sala (participante)',
        'Visão do participante comum, sem permissões de moderador.',
        {
          actor: 'attendee',
        },
      );
      await rec.state(
        att.page,
        'attendee-user-list',
        'Lista de usuários (participante)',
        'Painel de participantes visto por um participante.',
        {
          actor: 'attendee',
          enter: () => openUserListIfClosed(att),
        },
      );
      await rec.state(att.page, 'attendee-actions', 'Opções (participante)', 'Menu de opções do participante.', {
        actor: 'attendee',
        enter: () => att.waitAndClick(e.optionsButton),
        leave: () => esc(att.page),
      });

      await openPublicChatPanel(att);
      await clearAnnouncements(mod.page);
      for (const text of ['Olá, tudo bem?', 'Alguém me ouve?', 'Vou compartilhar uma dúvida']) {
        await sendChatMessage(att, text);
        await att.page.waitForTimeout(400);
      }
      await mod.page.waitForTimeout(2000);
      await rec.collectAnnouncements(mod.page, 'moderador: 3 mensagens no chat público com o chat aberto');

      await mod.waitAndClick(e.hidePublicChat);
      await clearAnnouncements(mod.page);
      for (const text of ['Mensagem com o chat fechado', 'Outra mensagem']) {
        await sendChatMessage(att, text);
        await att.page.waitForTimeout(400);
      }
      await mod.page.waitForTimeout(2000);
      await rec.collectAnnouncements(mod.page, 'moderador: 2 mensagens com o chat fechado');
      await rec.state(
        mod.page,
        'mod-unread-chat',
        'Chat não lido (moderador)',
        'Moderador com mensagens não lidas e o chat fechado.',
        {
          actor: 'moderator',
        },
      );

      await att.waitAndClick(e.raiseHandBtn);
      await mod.page.waitForTimeout(2000);
      await rec.collectAnnouncements(mod.page, 'moderador: participante levantou a mão');
      await rec.state(
        mod.page,
        'mod-raised-hand',
        'Mão levantada (moderador vê)',
        'Lista de usuários do moderador com um participante de mão levantada.',
        {
          actor: 'moderator',
          enter: () => openUserListIfClosed(mod),
        },
      );

      await clearAnnouncements(att.page);
      await startPoll(mod);
      await rec.state(
        att.page,
        'attendee-poll',
        'Responder enquete (participante)',
        'Modal de resposta à enquete na tela do participante.',
        {
          actor: 'attendee',
          enter: () => att.hasElement(e.pollingContainer, 'attendee should see the poll'),
        },
      );
      await rec.collectAnnouncements(att.page, 'participante: enquete iniciada');
      await answerPollOption(att, 'A');
      await mod.page.waitForTimeout(1500);
      await rec.state(
        mod.page,
        'mod-poll-results',
        'Resultados da enquete (moderador)',
        'Painel do moderador com uma resposta recebida.',
        {
          actor: 'moderator',
        },
      );
      await mod.waitAndClick(e.publishPollingLabel).catch(() => undefined);
      await att.page.waitForTimeout(2000);
      await rec.collectAnnouncements(att.page, 'participante: resultado da enquete publicado');

      await clearAnnouncements(att.page);
      try {
        await openUserListIfClosed(mod);
        await mod.page.locator(e.userListItem).filter({ hasText: 'Attendee' }).first().click();
        await mod.waitAndClick(e.startPrivateChat);
        await sendChatMessage(mod, 'Mensagem privada para o participante');
        await att.page.waitForTimeout(2000);
        await rec.collectAnnouncements(att.page, 'participante: recebeu mensagem privada');
        await rec.state(
          att.page,
          'attendee-private-message',
          'Mensagem privada recebida (participante)',
          'Tela do participante após receber uma mensagem privada.',
          {
            actor: 'attendee',
          },
        );
      } catch (err) {
        rec.note('privateChatError', String(err).slice(0, 300));
      }

      await clearAnnouncements(mod.page);
      await att.page.close();
      await mod.page.waitForTimeout(3000);
      await rec.collectAnnouncements(mod.page, 'moderador: participante saiu da sala');
    } catch (err) {
      rec.note('scenarioError', String(err).split('\n').slice(0, 2).join(' ').slice(0, 500));
    } finally {
      rec.write();
    }
  });

  test('breakout: rooms running', async ({ browser, context, page }, testInfo) => {
    test.skip(!wants('4.1', '2.2', '1.3', '1.4', '2.1', '2.4', '3.2'), 'not relevant to the selected topic');
    test.setTimeout(TIMEOUT);
    const rec = new AuditRecorder(
      {
        id: 'breakout',
        name: 'Salas de grupo em andamento',
        description:
          'O moderador cria uma sala de grupo com um participante. Audita o convite, a sala por dentro e o painel do moderador, e grava o que é anunciado durante 30 segundos sem interação (a contagem regressiva do tempo restante).',
        actors: ['attendee', 'moderator'],
      },
      auditOutDir(testInfo.outputPath('a11y-audit')),
    );
    try {
      await installAnnouncementRecorder(context);
      const users = new MultiUsers(browser, context);
      await users.initModPage(page, { testInfo });
      await users.initUserPage(context, { testInfo });
      const mod = users.modPage;
      const att = users.userPage;
      // the creation panel needs a wide viewport to show the start button
      await mod.setHeightWidthViewPortSize({ width: 1920, height: 1080 });
      await mod.waitAndClick(e.breakoutRoomSidebarButton);
      await mod.waitForSelector(e.attendeeNotAssigned, ELEMENT_WAIT_EXTRA_LONG_TIME);
      await mod.dragDropSelector(e.attendeeNotAssigned, e.breakoutBox1);
      await mod.waitAndClick(e.createBreakoutRoomsButton, ELEMENT_WAIT_LONGER_TIME);
      await mod.setHeightWidthViewPortSize();

      await rec.state(
        att.page,
        'attendee-invite',
        'Convite para a sala (participante)',
        'Modal que convida o participante a entrar na sala de grupo.',
        { actor: 'attendee', enter: () => att.hasElement(e.modalConfirmButton, 'attendee should be invited') },
      );
      const newTab = context.waitForEvent('page', { timeout: ELEMENT_WAIT_EXTRA_LONG_TIME }).catch(() => null);
      await att.waitAndClick(e.modalConfirmButton);
      const room = (await newTab) || att.page;
      await room.waitForLoadState('domcontentloaded');
      await room.locator(e.presentationTitle).waitFor({ state: 'visible', timeout: ELEMENT_WAIT_EXTRA_LONG_TIME });
      if (
        await room
          .locator(e.audioModal)
          .isVisible()
          .catch(() => false)
      ) {
        await room
          .locator(e.closeModal)
          .click()
          .catch(() => undefined);
      }
      await rec.state(
        room,
        'attendee-in-room',
        'Dentro da sala de grupo (participante)',
        'Cliente da sala de grupo, com o tempo restante.',
        { actor: 'attendee' },
      );
      await rec.state(
        mod.page,
        'mod-rooms-running',
        'Salas em andamento (moderador)',
        'Painel do moderador com a sala de grupo rodando.',
        { actor: 'moderator', enter: () => mod.hasElement(e.roomOptions1, 'rooms should be running') },
      );
      rec.note('recorderAlreadyInstalled', {
        room: await ensureAnnouncementRecorder(room),
        moderator: await ensureAnnouncementRecorder(mod.page),
      });
      await clearAnnouncements(room);
      await clearAnnouncements(mod.page);
      // Independent evidence: the countdown text itself, before and after the idle period.
      const remaining = async (pg: PlaywrightPage) =>
        pg
          .locator('[data-test="timeRemaining"]')
          .first()
          .textContent({ timeout: 2000 })
          .catch(() => null);
      const before = { room: await remaining(room), moderator: await remaining(mod.page) };
      await room.waitForTimeout(30000);
      rec.note('countdownText', {
        before,
        after: { room: await remaining(room), moderator: await remaining(mod.page) },
      });
      // Which live region (if any) contains the countdown: no region means it is never announced.
      const liveRegionOf = (pg: PlaywrightPage) =>
        pg
          .evaluate(() => {
            const el = document.querySelector('[data-test="timeRemaining"]');
            if (!el) return 'countdown not on screen';
            const region = el.closest('[aria-live]:not([aria-live="off"]),[role="status"],[role="alert"],[role="log"]');
            return region ? region.outerHTML.slice(0, 200) : 'no live region around the countdown';
          })
          .catch((err) => String(err).slice(0, 100));
      rec.note('countdownLiveRegion', { room: await liveRegionOf(room), moderator: await liveRegionOf(mod.page) });
      await rec.collectAnnouncements(room, 'participante na sala de grupo: 30 s sem interagir');
      await rec.collectAnnouncements(mod.page, 'moderador na sala principal: 30 s sem interagir');
      rec.note('idleSeconds', 30);
    } catch (err) {
      rec.note('scenarioError', String(err).split('\n').slice(0, 2).join(' ').slice(0, 500));
    } finally {
      rec.write();
    }
  });

  test('guest: waiting lobby and approval', async ({ browser, context, page }, testInfo) => {
    test.setTimeout(TIMEOUT);
    const rec = new AuditRecorder(
      {
        id: 'guest',
        name: 'Convidado na sala de espera',
        description:
          'Reunião com aprovação de convidados (guestPolicy=ASK_MODERATOR). Um convidado entra e fica na sala de espera; o moderador vê o pedido, manda uma mensagem para a sala de espera e aprova. Audita as telas dos dois e grava os anúncios.',
        actors: ['guest', 'moderator'],
      },
      auditOutDir(testInfo.outputPath('a11y-audit')),
    );
    try {
      await installAnnouncementRecorder(context);
      const users = new MultiUsers(browser, context);
      await users.initModPage(page, { testInfo, createParameter: 'guestPolicy=ASK_MODERATOR' });
      const mod = users.modPage;
      await clearAnnouncements(mod.page);
      await users.initUserPage2(context, {
        fullName: 'Convidado',
        joinParameter: 'guest=true',
        shouldCloseAudioModal: false,
        shouldCheckAllInitialSteps: false,
        testInfo,
      });
      const guest = users.userPage2;
      await rec.state(
        guest.page,
        'guest-lobby',
        'Sala de espera (convidado)',
        'Tela de espera do convidado aguardando aprovação.',
        {
          actor: 'guest',
          enter: () => guest.hasElement(e.guestMessage, 'guest should wait'),
        },
      );
      await rec.check('guest-lobby-keyboard', () => checkKeyboard(guest.page, 30), ['2.1', '2.4']);
      await rec.check('guest-lobby-reflow', () => checkReflow(guest.page), ['1.4']);
      await mod.page.waitForTimeout(1500);
      await rec.collectAnnouncements(mod.page, 'moderador: convidado aguardando aprovação');

      await rec.state(
        mod.page,
        'mod-waiting-list',
        'Pedidos de entrada (moderador)',
        'Painel do moderador com o convidado aguardando.',
        {
          actor: 'moderator',
          enter: async () => {
            await openUserListIfClosed(mod);
            await mod.waitAndClick(e.guestWaitingUsers);
            await mod.hasElement(e.waitingUserName, 'should list the waiting guest');
          },
        },
      );
      await clearAnnouncements(guest.page);
      try {
        await mod.page.locator(e.waitingUserName).first().hover();
        await mod.waitAndClick(PRIVATE_MESSAGE_GUEST);
        await mod.page.locator(PRIVATE_LOBBY_MESSAGE).fill('Aguarde um momento, já vamos liberar');
        await mod.page.keyboard.press('Enter');
        await guest.page.waitForTimeout(2000);
        await rec.collectAnnouncements(guest.page, 'convidado: recebeu mensagem do moderador na sala de espera');
        await rec.state(
          guest.page,
          'guest-lobby-message',
          'Mensagem na sala de espera (convidado)',
          'Sala de espera após o moderador enviar uma mensagem.',
          {
            actor: 'guest',
          },
        );
      } catch (err) {
        rec.note('lobbyMessageError', String(err).slice(0, 300));
      }
      await esc(mod.page);
      await mod.page.locator(e.waitingUserName).first().hover();
      await mod.waitAndClick(ACCEPT_GUEST);
      await rec.state(
        guest.page,
        'guest-admitted',
        'Convidado aprovado',
        'Primeira tela do convidado depois de ser aprovado.',
        {
          actor: 'guest',
          enter: () => guest.hasElement(e.audioModal, 'guest should reach the audio modal'),
        },
      );
      await rec.collectAnnouncements(guest.page, 'convidado: aprovado e entrou');
    } catch (err) {
      rec.note('scenarioError', String(err).split('\n').slice(0, 2).join(' ').slice(0, 500));
    } finally {
      rec.write();
    }
  });

  test('variant: Brazilian Portuguese locale', async ({ browser, page }, testInfo) => {
    test.skip(!wants('1.4', '3.1', '2.5'), 'not relevant to the selected topic');
    test.setTimeout(TIMEOUT);
    const rec = new AuditRecorder(
      {
        id: 'locale-pt-br',
        name: 'Idioma português (pt-BR)',
        description:
          'Mesma sala com o idioma do cliente em pt-BR. Confere o atributo lang da página e se textos mais longos que em inglês quebram o layout ou são cortados.',
        actors: ['variant'],
      },
      auditOutDir(testInfo.outputPath('a11y-audit')),
    );
    try {
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo, joinParameter: 'userdata-bbb_override_default_locale=pt-BR' });
      await rec.state(page, 'meeting', 'Sala em pt-BR', 'Estado principal com o cliente em português.');
      await rec.check('textSpacing', () => checkTextSpacing(page), ['1.4']);
      await rec.check('reflow', () => checkReflow(page), ['1.4']);
      await rec.state(page, 'public-chat', 'Chat em pt-BR', 'Chat público em português.', {
        enter: () => openPublicChatPanel(mod),
      });
      await rec.state(page, 'settings', 'Configurações em pt-BR', 'Modal de configurações em português.', {
        enter: () => mod.waitAndClick(e.settingsSidebarButton),
        leave: () => mod.waitAndClick(e.saveSettingsButton),
      });
      await rec.state(page, 'options-menu', 'Menu de opções em pt-BR', 'Menu geral em português.', {
        enter: () => mod.waitAndClick(e.optionsButton),
        leave: () => esc(page),
      });
    } catch (err) {
      rec.note('scenarioError', String(err).split('\n').slice(0, 2).join(' ').slice(0, 500));
    } finally {
      rec.write();
    }
  });

  test('variant: dark theme', async ({ browser, page }, testInfo) => {
    test.skip(!wants('1.4'), 'not relevant to the selected topic');
    test.setTimeout(TIMEOUT);
    const rec = new AuditRecorder(
      {
        id: 'dark-theme',
        name: 'Tema escuro',
        description:
          'Mesma sala com o modo escuro ligado nas configurações. Foco em contraste de texto e de componentes.',
        actors: ['variant'],
      },
      auditOutDir(testInfo.outputPath('a11y-audit')),
    );
    try {
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo });
      try {
        await mod.waitAndClick(e.settingsSidebarButton);
        await mod.waitAndClick(e.darkModeToggleBtn);
        await mod.waitAndClick(e.saveSettingsButton);
        await page.waitForTimeout(1500);
        rec.note(
          'darkModeEnabled',
          await page.evaluate(() => document.querySelectorAll('style.darkreader').length > 0),
        );
      } catch (err) {
        rec.note('darkModeError', String(err).slice(0, 300));
      }
      await rec.state(page, 'meeting', 'Sala no tema escuro', 'Estado principal com o tema escuro.');
      await rec.check('nonTextContrast', () => findNonTextContrastViolations(page), ['1.4']);
      await rec.state(page, 'public-chat', 'Chat no tema escuro', 'Chat público no tema escuro.', {
        enter: () => openPublicChatPanel(mod),
      });
      await rec.state(
        page,
        'user-list',
        'Lista de usuários no tema escuro',
        'Painel de participantes no tema escuro.',
        {
          enter: () => openUserListIfClosed(mod),
        },
      );
      await rec.state(page, 'settings', 'Configurações no tema escuro', 'Modal de configurações no tema escuro.', {
        enter: () => mod.waitAndClick(e.settingsSidebarButton),
        leave: () => esc(page),
      });
    } catch (err) {
      rec.note('scenarioError', String(err).split('\n').slice(0, 2).join(' ').slice(0, 500));
    } finally {
      rec.write();
    }
  });

  test('variant: mobile phone', async ({ browser }, testInfo) => {
    test.skip(!wants('1.1', '1.3', '1.4', '2.5', '4.1'), 'not relevant to the selected topic');
    test.setTimeout(TIMEOUT);
    const rec = new AuditRecorder(
      {
        id: 'mobile',
        name: 'Celular (emulado)',
        description:
          'Cliente aberto num celular Android emulado (Pixel 7, toque, user agent móvel), em retrato e paisagem. Não substitui um aparelho real, mas mostra o layout móvel, alvos de toque e orientação.',
        actors: ['variant'],
      },
      auditOutDir(testInfo.outputPath('a11y-audit')),
    );
    const context = await browser.newContext({ ...devices['Pixel 7'] });
    try {
      const page = await context.newPage();
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo, shouldCloseAudioModal: false });
      await rec.state(page, 'audio-modal', 'Modal de áudio no celular', 'Escolha de áudio no layout móvel.', {
        enter: () => mod.hasElement(e.audioModal, 'audio modal'),
      });
      await rec.state(
        page,
        'meeting-portrait',
        'Sala no celular (retrato)',
        'Estado principal no layout móvel em retrato.',
        {
          enter: async () => {
            if (await mod.checkElement(e.audioModal)) await mod.closeAudioModal();
          },
        },
      );
      await rec.state(page, 'public-chat', 'Chat no celular', 'Chat público no layout móvel.', {
        enter: () => openPublicChatPanel(mod),
        leave: () => mod.waitAndClick(e.hidePublicChat),
      });
      await rec.state(page, 'options-menu', 'Menu de opções no celular', 'Menu geral no layout móvel.', {
        enter: () => mod.waitAndClick(e.optionsButton),
        leave: () => esc(page),
      });
      await rec.state(page, 'meeting-landscape', 'Sala no celular (paisagem)', 'Mesmo aparelho girado para paisagem.', {
        enter: async () => {
          const size = page.viewportSize();
          if (size) await page.setViewportSize({ width: size.height, height: size.width });
          await page.waitForTimeout(1500);
        },
      });
    } catch (err) {
      rec.note('scenarioError', String(err).split('\n').slice(0, 2).join(' ').slice(0, 500));
    } finally {
      rec.write();
    }
    await context.close();
  });
});
