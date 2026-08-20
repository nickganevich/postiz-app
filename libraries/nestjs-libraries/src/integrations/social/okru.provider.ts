import {
  AuthTokenDetails,
  FetchPageInformationResult,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import dayjs from 'dayjs';
import {
  BadBody,
  RefreshToken,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import {
  okruSessionSecret,
  okruSignature,
} from '@gitroom/nestjs-libraries/integrations/social/okru.signature';
import { readOrFetch } from '@gitroom/helpers/utils/read.or.fetch';
import { Integration } from '@prisma/client';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
//@ts-ignore
import mime from 'mime';
import striptags from 'striptags';

const OK_API = 'https://api.ok.ru/fb.do';
const OK_TOKEN = 'https://api.ok.ru/oauth/token.do';
const OK_AUTHORIZE = 'https://connect.ok.ru/oauth/authorize';

// Текст в медиатопике режется площадкой; берём заведомо безопасный предел.
const OKRU_MAX_LENGTH = 16000;

// Коды сессии Одноклассников — повод переподключить канал, а не ретраить.
const SESSION_ERRORS = [102, 103];

type OkruMediaBlock =
  | { type: 'text'; text: string }
  | { type: 'photo'; list: { id: string }[] }
  | { type: 'movie'; movieId: string };

@Rules(
  'Одноклассники: пост в группу состоит из текстового блока и вложений (фото или видео). Ссылки лучше добавлять прямо в текст.'
)
export class OkruProvider extends SocialAbstract implements SocialProvider {
  identifier = 'okru';
  name = 'Одноклассники';
  // После OAuth пользователь выбирает группу, куда публиковать.
  isBetweenSteps = true;
  editor = 'normal' as const;
  scopes = [
    'VALUABLE_ACCESS',
    'LONG_ACCESS_TOKEN',
    'PHOTO_CONTENT',
    'VIDEO_CONTENT',
    'GROUP_CONTENT',
  ];

  maxLength() {
    return OKRU_MAX_LENGTH;
  }

  private get appId() {
    return process.env.OKRU_APP_ID || '';
  }

  private get appKey() {
    return process.env.OKRU_PUBLIC_KEY || '';
  }

  private get appSecret() {
    return process.env.OKRU_SECRET_KEY || '';
  }

  private get redirectUri() {
    return `${process.env.FRONTEND_URL}/integrations/social/okru`;
  }

  /**
   * Единая точка вызова REST API. Подписывает запрос и разбирает ошибки:
   * Одноклассники отвечают HTTP 200 даже на ошибку, признак — поле error_code.
   */
  private async call<T = any>(
    method: string,
    params: Record<string, string | number | boolean>,
    accessToken: string
  ): Promise<T> {
    const signedParams: Record<string, string | number | boolean> = {
      ...params,
      method,
      application_key: this.appKey,
      format: 'json',
    };

    const sig = okruSignature(
      signedParams,
      okruSessionSecret(accessToken, this.appSecret)
    );

    // Подпись считается по сырым значениям, кодируем только для передачи.
    const body = new URLSearchParams({
      ...Object.entries(signedParams).reduce(
        (all, [key, value]) => ({ ...all, [key]: String(value) }),
        {} as Record<string, string>
      ),
      sig,
      access_token: accessToken,
    });

    const response = await this.fetch(OK_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const text = await response.text();

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // Часть методов возвращает голую строку (например, id медиатопика).
      return text.replace(/"/g, '') as unknown as T;
    }

    if (parsed?.error_code) {
      if (SESSION_ERRORS.includes(Number(parsed.error_code))) {
        throw new RefreshToken(
          this.identifier,
          text,
          JSON.stringify(params),
          'Сессия Одноклассников истекла, подключите канал заново'
        );
      }

      throw new BadBody(
        this.identifier,
        text,
        JSON.stringify(params),
        parsed?.error_msg || 'Ошибка API Одноклассников'
      );
    }

    return parsed as T;
  }

  async generateAuthUrl() {
    const state = makeId(7);

    return {
      url:
        `${OK_AUTHORIZE}?client_id=${this.appId}` +
        `&scope=${this.scopes.join(';')}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(this.redirectUri)}` +
        `&state=${state}` +
        `&layout=w`,
      codeVerifier: makeId(10),
      state,
    };
  }

  async authenticate(params: { code: string; codeVerifier: string }) {
    const tokens = await (
      await this.fetch(OK_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: params.code,
          redirect_uri: this.redirectUri,
          grant_type: 'authorization_code',
          client_id: this.appId,
          client_secret: this.appSecret,
        }).toString(),
      })
    ).json();

    if (!tokens?.access_token) {
      throw new BadBody(
        this.identifier,
        JSON.stringify(tokens || {}),
        '{}',
        'Одноклассники не выдали токен доступа'
      );
    }

    const user = await this.call<{
      uid: string;
      name: string;
      pic128x128?: string;
    }>(
      'users.getCurrentUser',
      { fields: 'uid,name,pic128x128' },
      tokens.access_token
    );

    return {
      id: String(user.uid),
      name: user.name,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      // Токен с правом LONG_ACCESS_TOKEN живёт долго; обновляем по refresh_token.
      expiresIn: Number(tokens.expires_in) || dayjs().add(30, 'days').unix() - dayjs().unix(),
      picture: user.pic128x128 || '',
      username: String(user.uid),
    };
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const tokens = await (
      await this.fetch(OK_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
          client_id: this.appId,
          client_secret: this.appSecret,
        }).toString(),
      })
    ).json();

    if (!tokens?.access_token) {
      throw new RefreshToken(
        this.identifier,
        JSON.stringify(tokens || {}),
        '{}',
        'Одноклассники не обновили токен, подключите канал заново'
      );
    }

    const user = await this.call<{
      uid: string;
      name: string;
      pic128x128?: string;
    }>(
      'users.getCurrentUser',
      { fields: 'uid,name,pic128x128' },
      tokens.access_token
    );

    return {
      id: String(user.uid),
      name: user.name,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: Number(tokens.expires_in) || dayjs().add(30, 'days').unix() - dayjs().unix(),
      picture: user.pic128x128 || '',
      username: String(user.uid),
    };
  }

  /**
   * Список групп, где пользователь может публиковать. Название `pages` —
   * конвенция двухшаговых провайдеров (как у Facebook): по нему общий код
   * понимает, что после OAuth нужен шаг выбора площадки.
   */
  async pages(accessToken: string) {
    const list = await this.call<{
      groups: { groupId: string; role?: string[] }[];
    }>('group.getUserGroupsV2', { count: 100 }, accessToken);

    const ids = (list?.groups || []).map((group) => group.groupId);

    if (!ids.length) {
      return [];
    }

    const info = await this.call<
      { uid: string; name: string; pic_avatar?: string }[]
    >(
      'group.getInfo',
      { uids: ids.join(','), fields: 'uid,name,pic_avatar' },
      accessToken
    );

    return (info || []).map((group) => ({
      id: String(group.uid),
      name: group.name,
      picture: group.pic_avatar || '',
    }));
  }

  async fetchPageInformation(
    accessToken: string,
    data: { group: string }
  ): Promise<FetchPageInformationResult> {
    const [group] = await this.call<
      { uid: string; name: string; pic_avatar?: string }[]
    >(
      'group.getInfo',
      { uids: data.group, fields: 'uid,name,pic_avatar' },
      accessToken
    );

    return {
      id: String(group.uid),
      name: group.name,
      access_token: accessToken,
      picture: group.pic_avatar || '',
      username: String(group.uid),
    };
  }

  /** Фото загружается в альбом группы и возвращает токен для вложения. */
  private async uploadPhoto(
    accessToken: string,
    gid: string,
    path: string
  ): Promise<string> {
    const upload = await this.call<{
      upload_url: string;
      photo_ids: string[];
    }>('photosV2.getUploadUrl', { gid, count: 1 }, accessToken);

    const buffer = await readOrFetch(path);
    const form = new FormData();
    form.append(
      'photo',
      new Blob([new Uint8Array(buffer)], {
        type: mime.getType(path) || 'image/jpeg',
      }),
      path.split('/').pop() || 'photo.jpg'
    );

    const uploaded = await (
      await this.fetch(upload.upload_url, { method: 'POST', body: form })
    ).json();

    const token = uploaded?.photos?.[upload.photo_ids[0]]?.token;

    if (!token) {
      throw new BadBody(
        this.identifier,
        JSON.stringify(uploaded || {}),
        '{}',
        'Одноклассники не вернули токен загруженного фото'
      );
    }

    return token;
  }

  /** Видео загружается одним запросом (до 2 ГБ) и публикуется через video.update. */
  private async uploadVideo(
    accessToken: string,
    gid: string,
    path: string,
    title: string
  ): Promise<string> {
    const upload = await this.call<{ video_id: string; upload_url: string }>(
      'video.getUploadUrl',
      {
        gid,
        file_name: path.split('/').pop() || 'video.mp4',
        file_size: await this.mediaSize(path, this.identifier),
        title: title.slice(0, 100),
      },
      accessToken
    );

    const buffer = await readOrFetch(path);
    const form = new FormData();
    form.append(
      'data',
      new Blob([new Uint8Array(buffer)], {
        type: mime.getType(path) || 'video/mp4',
      }),
      path.split('/').pop() || 'video.mp4'
    );

    await this.fetch(upload.upload_url, { method: 'POST', body: form });

    // Делает видео видимым согласно настройкам приватности.
    await this.call('video.update', { vid: upload.video_id }, accessToken);

    return upload.video_id;
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;

    const text = striptags(firstPost.message || '').slice(0, OKRU_MAX_LENGTH);

    const media: OkruMediaBlock[] = [{ type: 'text', text }];

    const photoTokens: string[] = [];
    for (const item of firstPost.media || []) {
      const isVideo = (mime.getType(item.path) || '').startsWith('video/');

      if (isVideo) {
        const videoId = await this.uploadVideo(accessToken, id, item.path, text);
        media.push({ type: 'movie', movieId: videoId });
        continue;
      }

      photoTokens.push(await this.uploadPhoto(accessToken, id, item.path));
    }

    if (photoTokens.length) {
      media.push({
        type: 'photo',
        list: photoTokens.map((token) => ({ id: token })),
      });
    }

    const attachment = JSON.stringify({
      media,
      onBehalfOfGroup: 'true',
    });

    const topicId = await this.call<string>(
      'mediatopic.post',
      {
        attachment,
        type: 'GROUP_THEME',
        gid: id,
      },
      accessToken
    );

    return [
      {
        id: firstPost.id,
        postId: String(topicId),
        releaseURL: `https://ok.ru/group/${id}/topic/${topicId}`,
        status: 'completed',
      },
    ];
  }

  override async checkValidity(
    posts: Array<{ path: string; thumbnail?: string }[]>
  ): Promise<string | true> {
    for (const group of posts) {
      for (const item of group) {
        const isVideo = (mime.getType(item.path) || '').startsWith('video/');
        const size = await this.mediaSize(item.path, this.identifier);

        if (isVideo && size > 2 * 1024 * 1024 * 1024) {
          return 'Одноклассники принимают видео до 2 ГБ';
        }

        if (!isVideo && size > 32 * 1024 * 1024) {
          return 'Одноклассники принимают изображения до 32 МБ';
        }
      }
    }

    return true;
  }
}
