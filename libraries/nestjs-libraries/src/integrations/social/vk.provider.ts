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
import { createHash, randomBytes } from 'crypto';
import FormDataNew from 'form-data';
import mime from 'mime-types';
import { Integration } from '@prisma/client';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { VkDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/vk.dto';

// Заголовок поля в настройках канала, куда кладётся ключ доступа сообщества
// (Управление сообществом -> Работа с API -> Ключи доступа). Пользовательским
// токеном VK ID публиковать в сообщество нельзя, поэтому для сообществ этот
// ключ обязателен; для личной страницы поле просто остаётся пустым.
export const VK_COMMUNITY_KEY_TITLE = 'Ключ доступа сообщества';

export class VkProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 2; // VK has moderate API limits
  identifier = 'vk';
  name = 'VK';
  // После OAuth пользователь выбирает, куда постить: личная страница или сообщество.
  isBetweenSteps = true;
  scopes = [
    'vkid.personal_info',
    'email',
    'wall',
    'status',
    'docs',
    'photos',
    'video',
    'groups',
  ];

  editor = 'normal' as const;
  // wall.post принимает длинные тексты — лонгриды в ВК пишутся обычным постом
  maxLength() {
    return 16000;
  }

  async refreshToken(refresh: string): Promise<AuthTokenDetails> {
    const [oldRefreshToken, device_id] = refresh.split('&&&&');
    const formData = new FormData();
    formData.append('grant_type', 'refresh_token');
    formData.append('refresh_token', oldRefreshToken);
    formData.append('client_id', process.env.VK_ID!);
    formData.append('device_id', device_id);
    formData.append('state', makeId(32));
    formData.append('scope', this.scopes.join(' '));

    const { access_token, refresh_token, expires_in } = await (
      await this.fetch('https://id.vk.com/oauth2/auth', {
        method: 'POST',
        body: formData,
      })
    ).json();

    const newFormData = new FormData();
    newFormData.append('client_id', process.env.VK_ID!);
    newFormData.append('access_token', access_token);

    const {
      user: { user_id, first_name, last_name, avatar },
    } = await (
      await this.fetch('https://id.vk.com/oauth2/user_info', {
        method: 'POST',
        body: newFormData,
      })
    ).json();

    return {
      // префикс "u", чтобы pending-запись не совпала по internalId с уже
      // подключённым каналом (личным "u<id>"/легаси "<id>" или "-<gid>")
      id: `u${user_id}`,
      name: first_name + ' ' + last_name,
      accessToken: access_token,
      refreshToken: refresh_token + '&&&&' + device_id,
      expiresIn: dayjs().add(expires_in, 'seconds').unix() - dayjs().unix(),
      picture: avatar || '',
      username: first_name.toLowerCase(),
    };
  }

  // Путь колбэка совпадает с identifier провайдера, поэтому у канала-сообщества
  // он свой; оба адреса должны быть прописаны в приложении на id.vk.com.
  protected redirectUri() {
    const frontend =
      process?.env.FRONTEND_URL?.indexOf('https') == -1
        ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
        : `${process?.env.FRONTEND_URL}`;
    return `${frontend}/integrations/social/${this.identifier}`;
  }

  async generateAuthUrl() {
    const state = makeId(32);
    const codeVerifier = randomBytes(64).toString('base64url');
    const challenge = Buffer.from(
      createHash('sha256').update(codeVerifier).digest()
    )
      .toString('base64')
      .replace(/=*$/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    return {
      url:
        'https://id.vk.com/authorize' +
        `?response_type=code` +
        `&client_id=${process.env.VK_ID}` +
        `&code_challenge_method=S256` +
        `&code_challenge=${challenge}` +
        `&redirect_uri=${encodeURIComponent(this.redirectUri())}` +
        `&state=${state}` +
        `&scope=${encodeURIComponent(this.scopes.join(' '))}`,
      codeVerifier,
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    const [code, device_id] = params.code.split('&&&&');

    const formData = new FormData();
    formData.append('client_id', process.env.VK_ID!);
    formData.append('grant_type', 'authorization_code');
    formData.append('code_verifier', params.codeVerifier);
    formData.append('device_id', device_id);
    formData.append('code', code);
    formData.append('redirect_uri', this.redirectUri());

    const { access_token, scope, refresh_token, expires_in } = await (
      await this.fetch('https://id.vk.com/oauth2/auth', {
        method: 'POST',
        body: formData,
      })
    ).json();

    const newFormData = new FormData();
    newFormData.append('client_id', process.env.VK_ID!);
    newFormData.append('access_token', access_token);

    const {
      user: { user_id, first_name, last_name, avatar },
    } = await (
      await this.fetch('https://id.vk.com/oauth2/user_info', {
        method: 'POST',
        body: newFormData,
      })
    ).json();

    return {
      // префикс "u", чтобы pending-запись не совпала по internalId с уже
      // подключённым каналом (личным "u<id>"/легаси "<id>" или "-<gid>")
      id: `u${user_id}`,
      name: first_name + ' ' + last_name,
      accessToken: access_token,
      refreshToken: refresh_token + '&&&&' + device_id,
      expiresIn: dayjs().add(expires_in, 'seconds').unix() - dayjs().unix(),
      picture: avatar || '',
      username: first_name.toLowerCase(),
      additionalSettings: this.communityKeySetting(),
    };
  }

  protected communityKeySetting() {
    return [
      {
        title: VK_COMMUNITY_KEY_TITLE,
        description:
          'Нужен только для сообществ: Управление сообществом → Работа с API → Ключи доступа (права «Стена»). Публиковать в сообщество личным токеном VK не даёт, а грузить фото и видео умеет только личный токен — поэтому нужны оба.',
        type: 'text' as const,
        value: '',
      },
    ];
  }

  // internalId интеграции: "u<id>" или легаси "<id>" — личная страница, "-<gid>" — сообщество
  protected groupId(userId: string): string | null {
    return String(userId).startsWith('-') ? String(userId).slice(1) : null;
  }

  // числовой owner_id для VK API (срезает префикс "u" личной страницы)
  protected ownerId(userId: string): string {
    return String(userId).startsWith('u')
      ? String(userId).slice(1)
      : String(userId);
  }

  async pages(accessToken: string) {
    const { response: users } = await (
      await this.fetch(
        `https://api.vk.com/method/users.get?fields=photo_200&v=5.251&access_token=${accessToken}`
      )
    ).json();
    const [me] = users || [];

    const { response: groups } = await (
      await this.fetch(
        `https://api.vk.com/method/groups.get?extended=1&filter=admin,editor&fields=photo_200&v=5.251&access_token=${accessToken}`
      )
    ).json();

    return [
      ...(me
        ? [
            {
              id: `u${me.id}`,
              name: `${me.first_name} ${me.last_name} — личная страница`,
              picture: { data: { url: me.photo_200 || '' } },
            },
          ]
        : []),
      ...(groups?.items || []).map((group: any) => ({
        id: `-${group.id}`,
        name: group.name,
        picture: { data: { url: group.photo_200 || '' } },
      })),
    ];
  }

  async fetchPageInformation(
    accessToken: string,
    data: { page: string }
  ): Promise<FetchPageInformationResult> {
    const id = String(data.page);
    const gid = this.groupId(id);

    if (gid) {
      const { response } = await (
        await this.fetch(
          `https://api.vk.com/method/groups.getById?group_id=${gid}&fields=photo_200&v=5.251&access_token=${accessToken}`
        )
      ).json();
      // v5.251 возвращает { groups: [...] }, старые версии — массив
      const group = response?.groups?.[0] || response?.[0];
      return {
        id,
        name: group?.name || `Сообщество ${gid}`,
        access_token: accessToken,
        picture: group?.photo_200 || '',
        username: group?.screen_name || '',
      };
    }

    const { response } = await (
      await this.fetch(
        `https://api.vk.com/method/users.get?user_ids=${this.ownerId(
          id
        )}&fields=photo_200,screen_name&v=5.251&access_token=${accessToken}`
      )
    ).json();
    const [user] = response || [];
    return {
      id,
      name: user ? `${user.first_name} ${user.last_name}` : id,
      access_token: accessToken,
      picture: user?.photo_200 || '',
      username: user?.screen_name || '',
    };
  }

  async reConnect(
    id: string,
    requiredId: string,
    accessToken: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const information = await this.fetchPageInformation(accessToken, {
      page: requiredId,
    });
    return {
      id: information.id,
      name: information.name,
      accessToken: information.access_token,
      picture: information.picture,
      username: information.username,
      // чтобы поле ключа сообщества появилось в настройках и у каналов,
      // переподключённых поверх старого способа авторизации
      additionalSettings: this.communityKeySetting(),
    };
  }

  // Медиа на стену VK грузится только пользовательским токеном: у ключей
  // сообществ photos.getWallUploadServer / video.save закрыты (ошибка 27,
  // см. схему VK API — access_token_type: ["user"]). Основной токен канала
  // как раз пользовательский, поэтому по умолчанию грузим им.
  protected mediaToken(
    accessToken: string,
    integration?: Integration
  ): string | null {
    return accessToken;
  }

  // Токен для самой публикации. Для сообщества, подключённого через VK ID,
  // wall.post пользовательским токеном возвращает 1051 ("method is
  // unavailable with current profile type") — нужен ключ доступа сообщества,
  // который хранится в настройках канала.
  protected wallToken(
    accessToken: string,
    userId: string,
    integration?: Integration
  ): string {
    if (!this.groupId(userId)) {
      return accessToken;
    }
    return this.communityKey(integration) || accessToken;
  }

  // Ключ доступа сообщества: сначала настройки канала (шестерёнка у канала),
  // затем — форма подключения каналов, заведённых до перехода на VK ID:
  // там этот же ключ лежал как accessToken.
  protected communityKey(integration?: Integration): string | null {
    try {
      const settings = JSON.parse(integration?.additionalSettings || '[]');
      const found = settings.find(
        (s: { title: string }) => s.title === VK_COMMUNITY_KEY_TITLE
      );
      const value = String(found?.value || '').trim();
      if (value) {
        return value;
      }
    } catch (err) {
      // настройки могут быть пустыми — не повод падать, пробуем старую форму
    }

    try {
      const legacy = JSON.parse(
        AuthService.fixedDecryption(integration!.customInstanceDetails!)
      );
      return String(legacy.accessToken || '').trim() || null;
    } catch (err) {
      return null;
    }
  }

  // Разбирает строку вложений VK "photo-<owner>_<id>,video-<owner>_<id>"
  // в тот же вид, что отдаёт загрузчик — чтобы дальше код был общим.
  protected preloadedAttachments(
    settings: VkDto
  ): { id: string; type: string; owner: string }[] {
    return String(settings?.attachments || '')
      .split(',')
      .map((item) => item.trim().match(/^(photo|video|doc)(-?\d+)_(\d+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ type: m[1], owner: m[2], id: m[3] }));
  }

  protected isVideo(path: string) {
    return hasExtension(path, 'mp4') || hasExtension(path, 'mov');
  }

  // Токен VK ID живёт около часа. Ошибки авторизации отдаём как refresh_token,
  // иначе воркфлоу считает пост непоправимо сломанным и не пытается обновить
  // токен, хотя обновление — ровно то, что нужно (коды: 5 — токен протух или
  // отозван, 28 — приложение переавторизовано).
  private vkError(what: string, error?: any): never {
    const message = `VK отклонил ${what}: ${
      error?.error_msg || 'пустой ответ'
    }${error?.error_code ? ` (код ${error.error_code})` : ''}`;
    const json = JSON.stringify(error || {});
    const needsRefresh = error?.error_code === 5 || error?.error_code === 28;

    throw needsRefresh
      ? new RefreshToken(this.identifier, json, {} as any, message)
      : new BadBody(this.identifier, json, {} as any, message);
  }

  // Файл скачиваем целиком: загрузчик VK периодически обрывает chunked-стрим
  // и отвечает пустотой, а с известной длиной (knownLength) — нет.
  private async download(path: string): Promise<Buffer> {
    const { data } = await this.getSsrfSafeAxios().get(path, {
      responseType: 'arraybuffer',
    });
    return Buffer.from(data);
  }

  private async uploadToVk(uploadUrl: string, field: string, file: Buffer, name: string) {
    const formData = new FormDataNew();
    formData.append(field, file, {
      filename: name,
      contentType: mime.lookup(name) || undefined,
      knownLength: file.length,
    });

    return (
      await this.getSsrfSafeAxios().post(uploadUrl, formData, {
        headers: { ...formData.getHeaders() },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      })
    ).data;
  }

  // getWallUploadServer -> upload -> saveWallPhoto. Фото сохраняется во
  // владение сообщества (group_id), поэтому потом без проблем крепится
  // к записи, опубликованной ключом сообщества.
  private async uploadPhoto(
    gid: string | null,
    owner: string,
    accessToken: string,
    media: { path: string }
  ): Promise<{ id: string; type: string; owner: string }> {
    const file = await this.download(media.path);
    const fileName = media.path.split('/').at(-1) || 'photo.jpg';

    for (let attempt = 0; attempt < 3; attempt++) {
      const { response, error } = await (
        await this.fetch(
          `https://api.vk.com/method/photos.getWallUploadServer?v=5.251&access_token=${accessToken}${
            gid ? `&group_id=${gid}` : `&owner_id=${owner}`
          }`
        )
      ).json();

      if (error || !response?.upload_url) {
        this.vkError('photos.getWallUploadServer', error);
      }

      const uploaded = await this.uploadToVk(
        response.upload_url,
        'photo',
        file,
        fileName
      );

      // пустой ответ загрузчика — не ошибка запроса, а известная флакота VK
      if (uploaded?.photo && uploaded.photo !== '[]') {
        const body = new FormData();
        body.append('photo', uploaded.photo);
        body.append('server', String(uploaded.server));
        body.append('hash', uploaded.hash);
        if (gid) {
          body.append('group_id', gid);
        }

        const saved = await (
          await this.fetch(
            `https://api.vk.com/method/photos.saveWallPhoto?v=5.251&access_token=${accessToken}`,
            { method: 'POST', body }
          )
        ).json();

        if (saved?.error) {
          this.vkError('photos.saveWallPhoto', saved.error);
        }

        const [photo] = saved?.response || [];
        if (photo?.id) {
          return {
            id: String(photo.id),
            type: 'photo',
            owner: String(photo.owner_id ?? owner),
          };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    this.vkError('загрузку фото', {
      error_msg: `${fileName}: загрузчик трижды ответил пустотой`,
    });
  }

  // video.save -> upload. Вертикальное короткое видео VK сам показывает
  // в Клипах: отдельного метода для клипов в API нет.
  private async uploadVideo(
    gid: string | null,
    owner: string,
    accessToken: string,
    media: { path: string },
    meta: { name: string; description: string }
  ): Promise<{ id: string; type: string; owner: string }> {
    const { response, error } = await (
      await this.fetch(
        `https://api.vk.com/method/video.save?v=5.251&access_token=${accessToken}` +
          `&name=${encodeURIComponent(meta.name)}` +
          `&description=${encodeURIComponent(meta.description)}` +
          (gid ? `&group_id=${gid}` : '')
      )
    ).json();

    if (error || !response?.upload_url) {
      this.vkError('video.save', error);
    }

    const fileName = media.path.split('/').at(-1) || 'video.mp4';
    const uploaded = await this.uploadToVk(
      response.upload_url,
      'video_file',
      await this.download(media.path),
      fileName
    );

    const videoId = uploaded?.video_id || response.video_id;
    if (!videoId) {
      this.vkError('загрузку видео', {
        error_msg: `${fileName}: VK не вернул video_id`,
      });
    }

    return {
      id: String(videoId),
      type: 'video',
      owner: String(uploaded?.owner_id ?? response.owner_id ?? owner),
    };
  }

  // У видео в VK обязателен заголовок — берём первую непустую строку текста
  private videoTitle(message?: string) {
    const first = String(message || '')
      .split('\n')
      .find((line) => line.trim());
    return (first || 'Видео').trim().slice(0, 128);
  }

  protected async uploadMedia(
    userId: string,
    accessToken: string,
    post: PostDetails
  ): Promise<{ id: string; type: string; owner: string }[]> {
    const gid = this.groupId(userId);
    const owner = this.ownerId(userId);
    const result: { id: string; type: string; owner: string }[] = [];

    // последовательно, а не Promise.all: у VK лимит 3 запроса в секунду,
    // и параллельная заливка карусели упирается в него
    for (const media of post?.media || []) {
      result.push(
        this.isVideo(media.path)
          ? await this.uploadVideo(gid, owner, accessToken, media, {
              name: this.videoTitle(post.message),
              description: post.message || '',
            })
          : await this.uploadPhoto(gid, owner, accessToken, media)
      );
    }

    return result;
  }

  async post(
    userId: string,
    accessToken: string,
    postDetails: PostDetails<VkDto>[],
    integration?: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const settings = firstPost?.settings || ({} as VkDto);
    const gid = this.groupId(userId);
    const owner = this.ownerId(userId);
    const media = firstPost?.media || [];

    const preloaded = this.preloadedAttachments(settings);

    if (settings.post_type === 'clip') {
      const singleVideo = preloaded.length
        ? preloaded.length === 1 && preloaded[0].type === 'video'
        : media.length === 1 && this.isVideo(media[0].path);
      if (!singleVideo) {
        throw new BadBody(
          this.identifier,
          '{}',
          {} as any,
          'Клип — это ровно одно вертикальное видео (mp4). Уберите лишние файлы или выберите тип «Запись на стене».'
        );
      }
    }

    // Готовые вложения (photo-<gid>_<id>, video-<gid>_<id>) — медиа, которое
    // уже залито в сообщество заранее, при планировании. Тогда в момент
    // публикации пользовательский токен не нужен вовсе: wall.post ключом
    // сообщества крепит вложения по id.
    const mediaList = preloaded.length
      ? preloaded
      : media.length
      ? await this.uploadMedia(
          userId,
          this.requireMediaToken(accessToken, integration),
          firstPost
        )
      : [];

    // Клип — короткое видео, а не запись на стене. wall.post здесь не нужен
    // и не желателен: видео уже лежит в каталоге сообщества (video.save,
    // wallpost=0 — см. uploadVideo), ВК сам подхватывает подходящие ролики
    // в раздел «Клипы». Публикация на стену дублировала бы контент туда,
    // где его не просили — этого явно не хотели.
    if (settings.post_type === 'clip') {
      const [video] = mediaList;
      return [
        {
          id: firstPost.id,
          postId: video.id,
          releaseURL: `https://vk.com/video${video.owner}_${video.id}`,
          status: 'completed',
        },
      ];
    }

    const body = new FormData();
    body.append('message', firstPost.message || '');
    body.append('owner_id', owner);
    if (gid) {
      body.append('from_group', '1');
    }
    if (settings.close_comments) {
      body.append('close_comments', '1');
    }
    if (gid && settings.signed) {
      body.append('signed', '1');
    }
    if (mediaList.length) {
      body.append(
        'attachments',
        mediaList.map((p) => `${p.type}${p.owner}_${p.id}`).join(',')
      );
    }

    const { response, error } = await (
      await this.fetch(
        `https://api.vk.com/method/wall.post?v=5.251&access_token=${this.wallToken(
          accessToken,
          userId,
          integration
        )}&client_id=${process.env.VK_ID}`,
        {
          method: 'POST',
          body,
        }
      )
    ).json();

    // без проверки error пост с ошибкой VK помечался бы опубликованным
    // с releaseURL вида wall..._undefined
    if (error || !response?.post_id) {
      this.vkError('публикацию записи', error || { error_msg: 'нет post_id в ответе' });
    }

    return [
      {
        id: firstPost.id,
        postId: String(response.post_id),
        releaseURL: `https://vk.com/wall${owner}_${response.post_id}`,
        status: 'completed',
      },
    ];
  }

  // Отдельно от mediaToken, чтобы причина отказа доезжала до пользователя
  // текстом, а не падением на undefined внутри загрузчика.
  protected requireMediaToken(
    accessToken: string,
    integration?: Integration
  ): string {
    const token = this.mediaToken(accessToken, integration);
    if (!token) {
      throw new BadBody(
        this.identifier,
        '{}',
        {} as any,
        `Для медиа нужен пользовательский токен: ключам сообществ VK загрузка фото и видео запрещена. ${this.mediaTokenHint()}`
      );
    }
    return token;
  }

  protected mediaTokenHint(): string {
    return 'Переподключите канал через VK ID.';
  }


  async comment(
    userId: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [commentPost] = postDetails;

    // Upload media for the comment
    const mediaList = commentPost?.media?.length
      ? await this.uploadMedia(
          userId,
          this.requireMediaToken(accessToken, integration),
          commentPost
        )
      : [];

    const owner = this.ownerId(userId);
    const gid = this.groupId(userId);
    const body = new FormData();
    body.append('message', commentPost.message);
    body.append('post_id', postId);
    body.append('owner_id', owner);
    if (gid) {
      // в wall.createComment from_group — это id сообщества, а не флаг
      body.append('from_group', gid);
    }

    if (mediaList.length) {
      body.append(
        'attachments',
        mediaList.map((p) => `${p.type}${p.owner}_${p.id}`).join(',')
      );
    }

    const { response, error } = await (
      await this.fetch(
        `https://api.vk.com/method/wall.createComment?v=5.251&access_token=${this.wallToken(
          accessToken,
          userId,
          integration
        )}&client_id=${process.env.VK_ID}`,
        {
          method: 'POST',
          body,
        }
      )
    ).json();

    if (error || !response?.comment_id) {
      this.vkError('комментарий', error || { error_msg: 'нет comment_id в ответе' });
    }

    return [
      {
        id: commentPost.id,
        postId: String(response.comment_id),
        releaseURL: `https://vk.com/wall${owner}_${postId}`,
        status: 'completed',
      },
    ];
  }
}
