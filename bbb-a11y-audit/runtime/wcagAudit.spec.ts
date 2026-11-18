import { devices, Page as PlaywrightPage, TestInfo } from '@playwright/test';

import { ELEMENT_WAIT_EXTRA_LONG_TIME, ELEMENT_WAIT_LONGER_TIME, ELEMENT_WAIT_TIME } from '../core/constants';
import { elements as e } from '../core/elements';
import { Page } from '../core/page';
import { test } from '../core/setup/fixtures';
import { answerPollOption, openPoll, startPoll } from '../polling/util';
import { startScreenshare } from '../screenshare/util';
import { MultiUsers } from '../user/multiusers';
import { openLockViewers } from '../user/util';
import { findNonTextContrastViolations } from './nonTextContrast';
import { clearAnnouncements, ensureAnnouncementRecorder, installAnnouncementRecorder } from './wcagAuditAnnouncements';
import {
  checkFocusReturn,
  checkHoverFocus,
  checkKeyboard,
  checkMenuSelection,
  checkReflow,
  checkStateChange,
  checkTextSpacing,
} from './wcagAuditChecks';
import {
  auditOutDir,
  AuditRecorder,
  errorMessage,
  pressEscape,
  ScenarioInfo,
  StateOptions,
  wants,
} from './wcagAuditRecorder';

/**
 * WCAG 2.2 AA runtime audit used by the bbb-a11y-audit agent skill.
 *
 * This is an audit, not a regression test: it never fails because of violations. Each test is one
 * scenario and writes <A11Y_AUDIT_DIR>/<scenario>.json plus screenshots. Not tagged @ci, so it never
 * runs in CI. With A11Y_GUIDELINES set, scenarios and checks that cannot inform the topic are skipped.
 *
 *   A11Y_AUDIT_DIR=/abs/dir npx playwright test accessibility/wcagAudit.spec.ts --project=chromium --workers=1
 */

const SCENARIO_TIMEOUT = 15 * 60 * 1000;
const ANNOUNCEMENT_WAIT_MS = 2000;
const BREAKOUT_IDLE_MS = 30000;
const ACCEPT_GUEST = '[data-test="acceptGuest"]';
const PRIVATE_MESSAGE_GUEST = '[data-test="privateMessageGuest"]';
const PRIVATE_LOBBY_MESSAGE = '[data-test="privateLobbyMessage"]';
const TIME_REMAINING = '[data-test="timeRemaining"]';
const LIVE_REGION = '[aria-live]:not([aria-live="off"]),[role="status"],[role="alert"],[role="log"]';

type Steps = Pick<StateOptions, 'enter' | 'leave'>;

/** A menu, popover or modal: opened by clicking `trigger`, closed with Escape. */
const opensWith = (user: Page, trigger: string): Steps => ({
  enter: () => user.waitAndClick(trigger),
  leave: () => pressEscape(user.page),
});

/** A panel or mode switched on and off by the same control. */
const togglesWith = (user: Page, trigger: string): Steps => ({
  enter: () => user.waitAndClick(trigger),
  leave: () => user.waitAndClick(trigger),
});

/**
 * Runs one scenario: records everything into its JSON even when a step fails halfway, so a broken
 * flow shows up in the report as states that were not audited instead of a missing scenario.
 */
async function auditScenario(testInfo: TestInfo, scenario: ScenarioInfo, body: (rec: AuditRecorder) => Promise<void>) {
  test.setTimeout(SCENARIO_TIMEOUT);
  const rec = new AuditRecorder(scenario, auditOutDir(testInfo.outputPath('a11y-audit')));
  try {
    await body(rec);
  } catch (err) {
    rec.note('scenarioError', errorMessage(err, { lines: 2, max: 500 }));
  } finally {
    rec.write();
  }
}

/** Skips the current scenario when none of `topics` overlaps the requested topic. */
function skipUnlessTopic(...topics: string[]) {
  test.skip(!wants(...topics), 'not relevant to the selected topic');
}

async function openUserList(user: Page) {
  // isVisible() is a snapshot and is racy right after join: wait for the panel state instead.
  const isOpen = await user.page
    .locator(e.userListPanel)
    .waitFor({ state: 'visible', timeout: ELEMENT_WAIT_TIME })
    .then(() => true)
    .catch(() => false);
  if (!isOpen) {
    await user.waitAndClick(e.usersListSidebarButton);
    await user.hasElement(e.userListPanel, 'should open the user list panel');
  }
}

async function openPublicChat(user: Page) {
  const { page } = user;
  if (!(await page.locator(e.hidePublicChat).isVisible())) {
    // Mobile layout: the sidebar navigation is collapsed behind a toggle button.
    const sidebarToggle = page.locator(e.toggleSidebarNavigation).first();
    if (await sidebarToggle.isVisible()) {
      await sidebarToggle.click();
      await page.waitForTimeout(1500);
    }
    await page.locator(e.messagesSidebarButton).first().click();
    await page.waitForTimeout(1000);
    const chatButton = page.locator(e.chatButton).first();
    if (!(await page.locator(e.hidePublicChat).isVisible()) && (await chatButton.isVisible())) {
      await chatButton.click();
    }
  }
  await user.hasElement(e.hidePublicChat, 'should display the public chat');
}

async function sendChatMessage(user: Page, text: string) {
  await user.page.locator(e.chatBox).fill(text);
  await user.waitAndClick(e.sendButton);
}

async function sendChatMessages(user: Page, texts: string[]) {
  for (const text of texts) {
    await sendChatMessage(user, text);
    await user.page.waitForTimeout(400);
  }
}

/** The checks every main screen gets: keyboard walk, reflow, text spacing and non-text contrast. */
async function standardChecks(rec: AuditRecorder, page: PlaywrightPage, prefix = '') {
  await rec.check(`${prefix}keyboard`, () => checkKeyboard(page), ['2.1', '2.4']);
  await rec.check(`${prefix}reflow`, () => checkReflow(page), ['1.4']);
  await rec.check(`${prefix}textSpacing`, () => checkTextSpacing(page), ['1.4']);
  await rec.check(`${prefix}nonTextContrast`, () => findNonTextContrastViolations(page), ['1.4']);
}

async function runSequentially<T>(items: string[], run: (item: string) => Promise<T>) {
  const results: T[] = [];
  for (const item of items) results.push(await run(item));
  return results;
}

// ---------------------------------------------------------------------------------------------
// Moderator tour, in steps
// ---------------------------------------------------------------------------------------------

/** Which server and client build were audited (shown in the report). */
async function noteAuditedServer(rec: AuditRecorder, mod: Page) {
  const clientVersion = await mod.page.evaluate(() => {
    // @ts-ignore - injected on window by the client at runtime
    const app = window.meetingClientSettings?.public?.app || {};
    return { bbbServerVersion: app.bbbServerVersion || null, html5ClientBuild: app.html5ClientBuild || null };
  });
  rec.note('server', { url: (process.env.BBB_URL || '').replace(/\/bigbluebutton\/?$/, ''), ...clientVersion });
}

async function auditJoiningAudio(rec: AuditRecorder, mod: Page) {
  await rec.state(mod.page, {
    id: 'audio-modal',
    name: 'Modal de áudio',
    description: 'Primeira tela após entrar: escolha de como participar do áudio.',
    enter: () => mod.hasElement(e.audioModal, 'audio modal'),
  });
  await rec.state(mod.page, {
    id: 'audio-echo-test',
    name: 'Teste de eco',
    description: 'Etapa em que a pessoa confirma se está se ouvindo.',
    enter: async () => {
      await mod.clickMicrophoneButton();
      await mod.waitForSelector(e.stopHearingButton);
    },
  });
  await rec.state(mod.page, {
    id: 'meeting',
    name: 'Sala com áudio conectado',
    description: 'Estado principal da reunião, microfone conectado e mutado.',
    enter: async () => {
      await mod.waitAndClick(e.joinEchoTestButton);
      await mod.hasElement(e.unmuteMicButton, 'should be in audio');
    },
  });
}

/** Interaction checks on the main meeting screen: focus return, tooltips, toggles and device menus. */
async function checkMeetingControls(rec: AuditRecorder, page: PlaywrightPage) {
  const menuTriggers = [e.audioDropdownMenu, e.mediaAreaButton, e.optionsButton, e.leaveMeetingDropdown];

  await rec.check(
    'focusReturn',
    () => runSequentially([...menuTriggers, e.settingsSidebarButton], (trigger) => checkFocusReturn(page, trigger)),
    ['2.4', '2.1', '3.2'],
  );
  await rec.check(
    'hoverFocus',
    () =>
      checkHoverFocus(page, [
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
    async () => [
      ...(await runSequentially([e.unmuteMicButton, e.raiseHandBtn], (toggle) =>
        checkStateChange(page, toggle, 'click'),
      )),
      ...(await runSequentially([...menuTriggers, e.reactionsButton], (trigger) =>
        checkStateChange(page, trigger, 'escape'),
      )),
    ],
    ['4.1', '1.3'],
  );
  await rec.check(
    'deviceSelection',
    () =>
      runSequentially(['[id^="audioinput-"]', '[id^="audiooutput-"]'], (items) =>
        checkMenuSelection(page, e.audioDropdownMenu, items),
      ),
    ['4.1', '1.3'],
  );
}

async function auditPeopleAndChat(rec: AuditRecorder, mod: Page) {
  const { page } = mod;
  await rec.state(page, {
    id: 'audio-menu',
    name: 'Menu de áudio',
    description: 'Menu de dispositivos e saída do áudio.',
    ...opensWith(mod, e.audioDropdownMenu),
  });
  await rec.state(page, {
    id: 'user-list',
    name: 'Lista de usuários',
    description: 'Painel de participantes.',
    enter: () => openUserList(mod),
  });
  await rec.check('keyboard-user-list', () => checkKeyboard(page, 60), ['2.1', '2.4']);
  await rec.state(page, {
    id: 'user-item-menu',
    name: 'Menu de um participante',
    description: 'Menu aberto ao clicar no próprio nome na lista.',
    ...opensWith(mod, e.currentUser),
  });
  await rec.state(page, {
    id: 'lock-viewers',
    name: 'Travar participantes',
    description: 'Modal de bloqueio de recursos dos participantes.',
    enter: () => openLockViewers(mod),
  });
  await rec.state(page, {
    id: 'guest-policy',
    name: 'Política de convidados',
    description: 'Aba de política de convidados no mesmo modal.',
    ...opensWith(mod, e.guestPolicyTab),
  });
  await rec.state(page, {
    id: 'public-chat',
    name: 'Chat público',
    description: 'Painel de chat público aberto.',
    enter: async () => {
      await openPublicChat(mod);
      await sendChatMessage(mod, 'Mensagem de teste da auditoria');
    },
  });
  await rec.check('keyboard-public-chat', () => checkKeyboard(page, 60), ['2.1', '2.4']);
  await rec.state(page, {
    id: 'chat-options',
    name: 'Opções do chat',
    description: 'Menu de opções do chat (salvar, copiar, limpar).',
    ...opensWith(mod, e.chatOptions),
  });
}

async function auditSettingsAndTools(rec: AuditRecorder, mod: Page) {
  const { page } = mod;
  await rec.state(page, {
    id: 'settings',
    name: 'Configurações',
    description: 'Modal de configurações, aba inicial.',
    enter: () => mod.waitAndClick(e.settingsSidebarButton),
  });
  // Inside an open modal: focus must stay in the dialog (and not escape to the page behind it).
  await rec.check('keyboard-settings-modal', () => checkKeyboard(page, 40), ['2.1', '2.4']);
  await rec.state(page, {
    id: 'settings-shortcuts',
    name: 'Atalhos de teclado',
    description: 'Aba de atalhos dentro das configurações.',
    enter: () => mod.waitAndClick(e.shortcutsTab),
    leave: () => mod.waitAndClick(e.saveSettingsButton),
  });
  await rec.state(page, {
    id: 'poll-create',
    name: 'Criar enquete',
    description: 'Painel de criação de enquete com alternativas.',
    enter: () => openPoll(mod),
  });
  await rec.state(page, {
    id: 'poll-running',
    name: 'Enquete em andamento',
    description: 'Visão do moderador com a enquete iniciada.',
    enter: () => mod.waitAndClick(e.startPoll),
    leave: async () => {
      await mod.waitAndClick(e.publishPollingLabel);
      await mod.closeAllToastNotifications();
    },
  });
  await rec.state(page, {
    id: 'breakout',
    name: 'Salas de apoio',
    description: 'Painel de criação de salas de apoio (breakout).',
    ...togglesWith(mod, e.breakoutRoomSidebarButton),
  });
  await rec.state(page, {
    id: 'shared-notes',
    name: 'Notas compartilhadas',
    description: 'Editor de notas compartilhadas.',
    enter: async () => {
      await mod.waitAndClick(e.sharedNotesSidebarButton);
      await mod.hasElement(e.sharedNotesBackground, 'should display shared notes');
    },
    leave: () => mod.waitAndClick(e.sharedNotesSidebarButton),
  });
  await rec.state(page, {
    id: 'timer',
    name: 'Timer e cronômetro',
    description: 'Painel de timer.',
    ...togglesWith(mod, e.timerStopwatchFeature),
  });
  await rec.state(page, {
    id: 'reactions',
    name: 'Reações',
    description: 'Barra de reações aberta.',
    ...opensWith(mod, e.reactionsButton),
  });
  await rec.state(page, {
    id: 'raise-hand',
    name: 'Mão levantada',
    description: 'Estado com a mão levantada.',
    ...togglesWith(mod, e.raiseHandBtn),
  });
}

async function auditMediaAndSharing(rec: AuditRecorder, mod: Page) {
  const { page } = mod;
  await rec.state(page, {
    id: 'media-area-menu',
    name: 'Menu da área de mídia',
    description: 'Menu de compartilhamento (apresentação, vídeo externo, etc.).',
    ...opensWith(mod, e.mediaAreaButton),
  });
  await rec.state(page, {
    id: 'presentation-upload',
    name: 'Enviar apresentação',
    description: 'Modal de gerenciamento e upload de apresentações.',
    enter: async () => {
      await mod.waitAndClick(e.mediaAreaButton);
      await mod.waitAndClick(e.managePresentations);
    },
    leave: () => pressEscape(page),
  });
  await rec.state(page, {
    id: 'whiteboard-toolbar',
    name: 'Ferramentas do quadro branco',
    description: 'Barra de ferramentas do quadro branco (presenter).',
    enter: () => mod.hasElement(e.wbToolbar, 'should display the whiteboard toolbar'),
  });
  await rec.state(page, {
    id: 'whiteboard-menu',
    name: 'Menu do quadro branco',
    description: 'Menu principal do quadro branco.',
    ...opensWith(mod, e.wbOptions),
  });
  await rec.state(page, {
    id: 'webcam-preview',
    name: 'Prévia da webcam',
    description: 'Modal de prévia e configuração da câmera.',
    enter: async () => {
      await mod.waitAndClick(e.joinVideo);
      await mod.hasElement(e.startSharingWebcam, 'should display the webcam preview');
    },
  });
  await rec.state(page, {
    id: 'webcam-on',
    name: 'Webcam compartilhada',
    description: 'Sala com a câmera do moderador ligada.',
    enter: async () => {
      await mod.waitAndClick(e.startSharingWebcam);
      await mod.hasElement(e.leaveVideo, 'should share the webcam');
    },
  });
  await rec.state(page, {
    id: 'webcam-menu',
    name: 'Menu do vídeo',
    description: 'Menu de opções sobre o vídeo de um participante.',
    enter: () => mod.waitAndClick(e.dropdownWebcamButton),
    leave: async () => {
      await pressEscape(page);
      await mod.waitAndClick(e.leaveVideo);
    },
  });
  await rec.state(page, {
    id: 'screenshare',
    name: 'Compartilhando a tela',
    description: 'Sala com compartilhamento de tela ativo.',
    enter: () => startScreenshare(mod),
    leave: () => mod.waitAndClick(e.stopScreenSharing),
  });
}

async function auditMeetingMenus(rec: AuditRecorder, mod: Page) {
  const { page } = mod;
  await rec.state(page, {
    id: 'session-details',
    name: 'Detalhes da sessão',
    description: 'Modal com informações da reunião.',
    ...opensWith(mod, e.sessionDetailsButton),
  });
  await rec.state(page, {
    id: 'connection-status',
    name: 'Status da conexão',
    description: 'Modal de status da conexão.',
    ...opensWith(mod, e.connectionStatusBtn),
  });
  await rec.state(page, {
    id: 'options-menu',
    name: 'Menu de opções',
    description: 'Menu geral (tela cheia, sobre, sair...).',
    ...opensWith(mod, e.optionsButton),
  });
  await rec.state(page, {
    id: 'leave-menu',
    name: 'Menu de sair',
    description: 'Menu do botão de saída da reunião.',
    enter: () => mod.waitAndClick(e.leaveMeetingDropdown),
  });
  await rec.state(page, {
    id: 'end-meeting',
    name: 'Confirmar encerramento',
    description: 'Modal de confirmação para encerrar a reunião para todos.',
    ...opensWith(mod, e.endMeetingButton),
  });
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

test.describe('WCAG audit', { tag: '@a11y-audit' }, () => {
  test('moderator: full tour of the meeting UI', async ({ browser, context, page }, testInfo) => {
    const scenario: ScenarioInfo = {
      id: 'moderator',
      name: 'Moderador sozinho na sala',
      description:
        'Um moderador entra, conecta o áudio e percorre todos os painéis, menus e modais disponíveis para ele: lista de usuários, chat, configurações, enquete, breakout, notas, timer, reações, webcam, compartilhamento de tela, quadro branco e saída da reunião.',
      actors: ['moderator'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      await installAnnouncementRecorder(context);
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo, shouldCloseAudioModal: false });
      await noteAuditedServer(rec, mod);

      await auditJoiningAudio(rec, mod);
      await standardChecks(rec, mod.page);
      await checkMeetingControls(rec, mod.page);
      await auditPeopleAndChat(rec, mod);
      await auditSettingsAndTools(rec, mod);
      await auditMediaAndSharing(rec, mod);
      await auditMeetingMenus(rec, mod);
      await rec.collectAnnouncements(mod.page, 'moderador');
    });
  });

  test('interactions: moderator and attendee', async ({ browser, context, page }, testInfo) => {
    const scenario: ScenarioInfo = {
      id: 'interactions',
      name: 'Moderador e participante interagindo',
      description:
        'Duas pessoas na mesma sala. O participante entra, manda mensagens no chat (com o chat do moderador aberto e depois fechado), levanta a mão, responde uma enquete e recebe uma mensagem privada. Grava o que seria anunciado ao leitor de tela de cada um e audita as telas do participante.',
      actors: ['attendee', 'moderator'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      await installAnnouncementRecorder(context);
      const users = new MultiUsers(browser, context);
      await users.initModPage(page, { testInfo });
      const mod = users.modPage;
      await openPublicChat(mod);
      await clearAnnouncements(mod.page);
      rec.note('announcementsDiscarded', 'logs before the attendee joined are not kept');
      await users.initUserPage(context, { testInfo });
      const att = users.userPage;
      await att.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(mod.page, 'moderador: participante entrou na sala');

      // What an attendee sees
      await rec.state(att.page, {
        id: 'attendee-meeting',
        name: 'Sala (participante)',
        description: 'Visão do participante comum, sem permissões de moderador.',
        actor: 'attendee',
      });
      await rec.state(att.page, {
        id: 'attendee-user-list',
        name: 'Lista de usuários (participante)',
        description: 'Painel de participantes visto por um participante.',
        actor: 'attendee',
        enter: () => openUserList(att),
      });
      await rec.state(att.page, {
        id: 'attendee-actions',
        name: 'Opções (participante)',
        description: 'Menu de opções do participante.',
        actor: 'attendee',
        ...opensWith(att, e.optionsButton),
      });

      // Chat messages, with the moderator's chat open and then closed
      await openPublicChat(att);
      await clearAnnouncements(mod.page);
      await sendChatMessages(att, ['Olá, tudo bem?', 'Alguém me ouve?', 'Vou compartilhar uma dúvida']);
      await mod.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(mod.page, 'moderador: 3 mensagens no chat público com o chat aberto');

      await mod.waitAndClick(e.hidePublicChat);
      await clearAnnouncements(mod.page);
      await sendChatMessages(att, ['Mensagem com o chat fechado', 'Outra mensagem']);
      await mod.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(mod.page, 'moderador: 2 mensagens com o chat fechado');
      await rec.state(mod.page, {
        id: 'mod-unread-chat',
        name: 'Chat não lido (moderador)',
        description: 'Moderador com mensagens não lidas e o chat fechado.',
        actor: 'moderator',
      });

      // Raised hand
      await att.waitAndClick(e.raiseHandBtn);
      await mod.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(mod.page, 'moderador: participante levantou a mão');
      await rec.state(mod.page, {
        id: 'mod-raised-hand',
        name: 'Mão levantada (moderador vê)',
        description: 'Lista de usuários do moderador com um participante de mão levantada.',
        actor: 'moderator',
        enter: () => openUserList(mod),
      });

      // Poll, from both sides
      await clearAnnouncements(att.page);
      await startPoll(mod);
      await rec.state(att.page, {
        id: 'attendee-poll',
        name: 'Responder enquete (participante)',
        description: 'Modal de resposta à enquete na tela do participante.',
        actor: 'attendee',
        enter: () => att.hasElement(e.pollingContainer, 'attendee should see the poll'),
      });
      await rec.collectAnnouncements(att.page, 'participante: enquete iniciada');
      await answerPollOption(att, 'A');
      await mod.page.waitForTimeout(1500);
      await rec.state(mod.page, {
        id: 'mod-poll-results',
        name: 'Resultados da enquete (moderador)',
        description: 'Painel do moderador com uma resposta recebida.',
        actor: 'moderator',
      });
      await mod.waitAndClick(e.publishPollingLabel).catch(() => undefined);
      await att.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
      await rec.collectAnnouncements(att.page, 'participante: resultado da enquete publicado');

      // Private message
      await clearAnnouncements(att.page);
      try {
        await openUserList(mod);
        await mod.page.locator(e.userListItem).filter({ hasText: 'Attendee' }).first().click();
        await mod.waitAndClick(e.startPrivateChat);
        await sendChatMessage(mod, 'Mensagem privada para o participante');
        await att.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
        await rec.collectAnnouncements(att.page, 'participante: recebeu mensagem privada');
        await rec.state(att.page, {
          id: 'attendee-private-message',
          name: 'Mensagem privada recebida (participante)',
          description: 'Tela do participante após receber uma mensagem privada.',
          actor: 'attendee',
        });
      } catch (err) {
        rec.note('privateChatError', String(err).slice(0, 300));
      }

      // Attendee leaves
      await clearAnnouncements(mod.page);
      await att.page.close();
      await mod.page.waitForTimeout(3000);
      await rec.collectAnnouncements(mod.page, 'moderador: participante saiu da sala');
    });
  });

  test('breakout: rooms running', async ({ browser, context, page }, testInfo) => {
    skipUnlessTopic('4.1', '2.2', '1.3', '1.4', '2.1', '2.4', '3.2');
    const scenario: ScenarioInfo = {
      id: 'breakout',
      name: 'Salas de grupo em andamento',
      description:
        'O moderador cria uma sala de grupo com um participante. Audita o convite, a sala por dentro e o painel do moderador, e grava o que é anunciado durante 30 segundos sem interação (a contagem regressiva do tempo restante).',
      actors: ['attendee', 'moderator'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      await installAnnouncementRecorder(context);
      const users = new MultiUsers(browser, context);
      await users.initModPage(page, { testInfo });
      await users.initUserPage(context, { testInfo });
      const mod = users.modPage;
      const att = users.userPage;

      // The creation panel needs a wide viewport to show the start button.
      await mod.setHeightWidthViewPortSize({ width: 1920, height: 1080 });
      await mod.waitAndClick(e.breakoutRoomSidebarButton);
      await mod.waitForSelector(e.attendeeNotAssigned, ELEMENT_WAIT_EXTRA_LONG_TIME);
      await mod.dragDropSelector(e.attendeeNotAssigned, e.breakoutBox1);
      await mod.waitAndClick(e.createBreakoutRoomsButton, ELEMENT_WAIT_LONGER_TIME);
      await mod.setHeightWidthViewPortSize();

      await rec.state(att.page, {
        id: 'attendee-invite',
        name: 'Convite para a sala (participante)',
        description: 'Modal que convida o participante a entrar na sala de grupo.',
        actor: 'attendee',
        enter: () => att.hasElement(e.modalConfirmButton, 'attendee should be invited'),
      });
      const roomTab = context.waitForEvent('page', { timeout: ELEMENT_WAIT_EXTRA_LONG_TIME }).catch(() => null);
      await att.waitAndClick(e.modalConfirmButton);
      const room = (await roomTab) || att.page;
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
      await rec.state(room, {
        id: 'attendee-in-room',
        name: 'Dentro da sala de grupo (participante)',
        description: 'Cliente da sala de grupo, com o tempo restante.',
        actor: 'attendee',
      });
      await rec.state(mod.page, {
        id: 'mod-rooms-running',
        name: 'Salas em andamento (moderador)',
        description: 'Painel do moderador com a sala de grupo rodando.',
        actor: 'moderator',
        enter: () => mod.hasElement(e.roomOptions1, 'rooms should be running'),
      });

      // Idle period: is the countdown announced, and how often?
      rec.note('recorderAlreadyInstalled', {
        room: await ensureAnnouncementRecorder(room),
        moderator: await ensureAnnouncementRecorder(mod.page),
      });
      await clearAnnouncements(room);
      await clearAnnouncements(mod.page);
      // Independent evidence: the countdown text itself, before and after the idle period.
      const timeRemaining = (tab: PlaywrightPage) =>
        tab
          .locator(TIME_REMAINING)
          .first()
          .textContent({ timeout: 2000 })
          .catch(() => null);
      const before = { room: await timeRemaining(room), moderator: await timeRemaining(mod.page) };
      await room.waitForTimeout(BREAKOUT_IDLE_MS);
      rec.note('countdownText', {
        before,
        after: { room: await timeRemaining(room), moderator: await timeRemaining(mod.page) },
      });
      // Which live region (if any) contains the countdown: no region means it is never announced.
      const liveRegionAroundCountdown = (tab: PlaywrightPage) =>
        tab
          .evaluate(
            ({ countdown, liveRegion }) => {
              const el = document.querySelector(countdown);
              if (!el) return 'countdown not on screen';
              const region = el.closest(liveRegion);
              return region ? region.outerHTML.slice(0, 200) : 'no live region around the countdown';
            },
            { countdown: TIME_REMAINING, liveRegion: LIVE_REGION },
          )
          .catch((err) => String(err).slice(0, 100));
      rec.note('countdownLiveRegion', {
        room: await liveRegionAroundCountdown(room),
        moderator: await liveRegionAroundCountdown(mod.page),
      });
      await rec.collectAnnouncements(room, 'participante na sala de grupo: 30 s sem interagir');
      await rec.collectAnnouncements(mod.page, 'moderador na sala principal: 30 s sem interagir');
      rec.note('idleSeconds', BREAKOUT_IDLE_MS / 1000);
    });
  });

  test('guest: waiting lobby and approval', async ({ browser, context, page }, testInfo) => {
    const scenario: ScenarioInfo = {
      id: 'guest',
      name: 'Convidado na sala de espera',
      description:
        'Reunião com aprovação de convidados (guestPolicy=ASK_MODERATOR). Um convidado entra e fica na sala de espera; o moderador vê o pedido, manda uma mensagem para a sala de espera e aprova. Audita as telas dos dois e grava os anúncios.',
      actors: ['guest', 'moderator'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
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

      await rec.state(guest.page, {
        id: 'guest-lobby',
        name: 'Sala de espera (convidado)',
        description: 'Tela de espera do convidado aguardando aprovação.',
        actor: 'guest',
        enter: () => guest.hasElement(e.guestMessage, 'guest should wait'),
      });
      await rec.check('guest-lobby-keyboard', () => checkKeyboard(guest.page, 30), ['2.1', '2.4']);
      await rec.check('guest-lobby-reflow', () => checkReflow(guest.page), ['1.4']);
      await mod.page.waitForTimeout(1500);
      await rec.collectAnnouncements(mod.page, 'moderador: convidado aguardando aprovação');

      await rec.state(mod.page, {
        id: 'mod-waiting-list',
        name: 'Pedidos de entrada (moderador)',
        description: 'Painel do moderador com o convidado aguardando.',
        actor: 'moderator',
        enter: async () => {
          await openUserList(mod);
          await mod.waitAndClick(e.guestWaitingUsers);
          await mod.hasElement(e.waitingUserName, 'should list the waiting guest');
        },
      });

      await clearAnnouncements(guest.page);
      try {
        await mod.page.locator(e.waitingUserName).first().hover();
        await mod.waitAndClick(PRIVATE_MESSAGE_GUEST);
        await mod.page.locator(PRIVATE_LOBBY_MESSAGE).fill('Aguarde um momento, já vamos liberar');
        await mod.page.keyboard.press('Enter');
        await guest.page.waitForTimeout(ANNOUNCEMENT_WAIT_MS);
        await rec.collectAnnouncements(guest.page, 'convidado: recebeu mensagem do moderador na sala de espera');
        await rec.state(guest.page, {
          id: 'guest-lobby-message',
          name: 'Mensagem na sala de espera (convidado)',
          description: 'Sala de espera após o moderador enviar uma mensagem.',
          actor: 'guest',
        });
      } catch (err) {
        rec.note('lobbyMessageError', String(err).slice(0, 300));
      }

      await pressEscape(mod.page);
      await mod.page.locator(e.waitingUserName).first().hover();
      await mod.waitAndClick(ACCEPT_GUEST);
      await rec.state(guest.page, {
        id: 'guest-admitted',
        name: 'Convidado aprovado',
        description: 'Primeira tela do convidado depois de ser aprovado.',
        actor: 'guest',
        enter: () => guest.hasElement(e.audioModal, 'guest should reach the audio modal'),
      });
      await rec.collectAnnouncements(guest.page, 'convidado: aprovado e entrou');
    });
  });

  test('variant: Brazilian Portuguese locale', async ({ browser, page }, testInfo) => {
    skipUnlessTopic('1.4', '3.1', '2.5');
    const scenario: ScenarioInfo = {
      id: 'locale-pt-br',
      name: 'Idioma português (pt-BR)',
      description:
        'Mesma sala com o idioma do cliente em pt-BR. Confere o atributo lang da página e se textos mais longos que em inglês quebram o layout ou são cortados.',
      actors: ['variant'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo, joinParameter: 'userdata-bbb_override_default_locale=pt-BR' });
      await rec.state(page, {
        id: 'meeting',
        name: 'Sala em pt-BR',
        description: 'Estado principal com o cliente em português.',
      });
      await rec.check('textSpacing', () => checkTextSpacing(page), ['1.4']);
      await rec.check('reflow', () => checkReflow(page), ['1.4']);
      await rec.state(page, {
        id: 'public-chat',
        name: 'Chat em pt-BR',
        description: 'Chat público em português.',
        enter: () => openPublicChat(mod),
      });
      await rec.state(page, {
        id: 'settings',
        name: 'Configurações em pt-BR',
        description: 'Modal de configurações em português.',
        enter: () => mod.waitAndClick(e.settingsSidebarButton),
        leave: () => mod.waitAndClick(e.saveSettingsButton),
      });
      await rec.state(page, {
        id: 'options-menu',
        name: 'Menu de opções em pt-BR',
        description: 'Menu geral em português.',
        ...opensWith(mod, e.optionsButton),
      });
    });
  });

  test('variant: dark theme', async ({ browser, page }, testInfo) => {
    skipUnlessTopic('1.4');
    const scenario: ScenarioInfo = {
      id: 'dark-theme',
      name: 'Tema escuro',
      description:
        'Mesma sala com o modo escuro ligado nas configurações. Foco em contraste de texto e de componentes.',
      actors: ['variant'],
    };
    await auditScenario(testInfo, scenario, async (rec) => {
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo });
      try {
        await mod.waitAndClick(e.settingsSidebarButton);
        await mod.waitAndClick(e.darkModeToggleBtn);
        await mod.waitAndClick(e.saveSettingsButton);
        await page.waitForTimeout(1500);
        const darkReaderActive = await page.evaluate(() => document.querySelectorAll('style.darkreader').length > 0);
        rec.note('darkModeEnabled', darkReaderActive);
      } catch (err) {
        rec.note('darkModeError', String(err).slice(0, 300));
      }
      await rec.state(page, {
        id: 'meeting',
        name: 'Sala no tema escuro',
        description: 'Estado principal com o tema escuro.',
      });
      await rec.check('nonTextContrast', () => findNonTextContrastViolations(page), ['1.4']);
      await rec.state(page, {
        id: 'public-chat',
        name: 'Chat no tema escuro',
        description: 'Chat público no tema escuro.',
        enter: () => openPublicChat(mod),
      });
      await rec.state(page, {
        id: 'user-list',
        name: 'Lista de usuários no tema escuro',
        description: 'Painel de participantes no tema escuro.',
        enter: () => openUserList(mod),
      });
      await rec.state(page, {
        id: 'settings',
        name: 'Configurações no tema escuro',
        description: 'Modal de configurações no tema escuro.',
        ...opensWith(mod, e.settingsSidebarButton),
      });
    });
  });

  test('variant: mobile phone', async ({ browser }, testInfo) => {
    skipUnlessTopic('1.1', '1.3', '1.4', '2.5', '4.1');
    const scenario: ScenarioInfo = {
      id: 'mobile',
      name: 'Celular (emulado)',
      description:
        'Cliente aberto num celular Android emulado (Pixel 7, toque, user agent móvel), em retrato e paisagem. Não substitui um aparelho real, mas mostra o layout móvel, alvos de toque e orientação.',
      actors: ['variant'],
    };
    const phone = await browser.newContext({ ...devices['Pixel 7'] });
    await auditScenario(testInfo, scenario, async (rec) => {
      const page = await phone.newPage();
      const mod = new Page(browser, page, testInfo);
      await mod.init(true, { testInfo, shouldCloseAudioModal: false });
      await rec.state(page, {
        id: 'audio-modal',
        name: 'Modal de áudio no celular',
        description: 'Escolha de áudio no layout móvel.',
        enter: () => mod.hasElement(e.audioModal, 'audio modal'),
      });
      await rec.state(page, {
        id: 'meeting-portrait',
        name: 'Sala no celular (retrato)',
        description: 'Estado principal no layout móvel em retrato.',
        enter: async () => {
          if (await mod.checkElement(e.audioModal)) await mod.closeAudioModal();
        },
      });
      await rec.state(page, {
        id: 'public-chat',
        name: 'Chat no celular',
        description: 'Chat público no layout móvel.',
        enter: () => openPublicChat(mod),
        leave: () => mod.waitAndClick(e.hidePublicChat),
      });
      await rec.state(page, {
        id: 'options-menu',
        name: 'Menu de opções no celular',
        description: 'Menu geral no layout móvel.',
        ...opensWith(mod, e.optionsButton),
      });
      await rec.state(page, {
        id: 'meeting-landscape',
        name: 'Sala no celular (paisagem)',
        description: 'Mesmo aparelho girado para paisagem.',
        enter: async () => {
          const size = page.viewportSize();
          if (size) await page.setViewportSize({ width: size.height, height: size.width });
          await page.waitForTimeout(1500);
        },
      });
    });
    await phone.close();
  });
});
