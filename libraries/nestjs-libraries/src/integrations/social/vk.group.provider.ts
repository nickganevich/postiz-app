import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { Integration } from '@prisma/client';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { BadBody } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import FormDataNew from 'form-data';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import dayjs from 'dayjs';
import { VkProvider } from '@gitroom/nestjs-libraries/integrations/social/vk.provider';

// Публикация в сообщество VK через "ключ доступа сообщества".
//
// Токены VK ID (обычный vk-провайдер) не могут постить в сообщества —
// wall.post с owner_id=-gid возвращает 1051 "method is unavailable with
// current profile type". Ключ сообщества (Управление сообществом → Работа
// с API → Ключи доступа) этим ограничением не связан и не протухает.
// Весь код постинга/загрузки медиа наследуется от VkProvider: internalId
// хранится как "-<gid>", ключ сообщества играет роль accessToken.
export class VkGroupProvider extends VkProvider {
  override identifier = 'vk-group';
  override name = 'VK Сообщество';
  override isBetweenSteps = false;
  override scopes: string[] = [];

  async customFields() {
    return [
      {
        key: 'group',
        label: 'Ссылка на сообщество (vk.com/...) или его ID',
        validation: `/^.+$/`,
        type: 'text' as const,
      },
      {
        key: 'accessToken',
        label:
          'Ключ доступа сообщества (Управление → Работа с API → Ключи доступа)',
        validation: `/^.{20,}$/`,
        type: 'password' as const,
      },
      {
        key: 'userToken',
        label:
          'Токен админа для фото/видео (vkhost.github.io, можно оставить пустым — тогда посты только с текстом)',
        validation: `/^.*$/`,
        type: 'password' as const,
      },
    ];
  }

  override async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  // Из "https://vk.com/kegelapp", "vk.com/club238196272", "kegelapp" или
  // "238196272" достаём то, что понимает groups.getById
  private extractGroupId(raw: string): string {
    const cleaned = raw
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/^(m\.)?vk\.(com|ru)\//, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
    const clubMatch = cleaned.match(/^(?:club|public|event)(\d+)$/);
    if (clubMatch) {
      return clubMatch[1];
    }
    return cleaned.replace(/^-/, '');
  }

  override async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    let body: { group?: string; accessToken?: string; userToken?: string };
    try {
      body = JSON.parse(Buffer.from(params.code, 'base64').toString());
    } catch (err) {
      return 'Неверные данные формы';
    }

    const token = (body.accessToken || '').trim();
    const groupQuery = this.extractGroupId(body.group || '');
    if (!token || !groupQuery) {
      return 'Укажите сообщество и ключ доступа';
    }

    const { response, error } = await (
      await this.fetch(
        `https://api.vk.com/method/groups.getById?group_ids=${encodeURIComponent(
          groupQuery
        )}&fields=photo_200&v=5.251&access_token=${token}`
      )
    ).json();

    if (error || !response) {
      return `Ключ не подошёл: ${
        error?.error_msg || 'VK не ответил'
      }. Проверьте, что ключ создан именно в этом сообществе с правами «стена» и «фотографии».`;
    }

    const group = response?.groups?.[0] || response?.[0];
    if (!group?.id) {
      return 'Сообщество не найдено — проверьте ссылку';
    }

    // Опциональный пользовательский токен админа: единственный способ
    // грузить фото на стену сообщества (ключам сообществ VK это запрещает,
    // см. dev.vk.ru/ru/method/photos.getWallUploadServer). Проверяем сразу,
    // чтобы канал не подключился с нерабочим токеном.
    const userToken = (body.userToken || '').trim();
    if (userToken) {
      const check = await (
        await this.fetch(
          `https://api.vk.com/method/photos.getWallUploadServer?group_id=${group.id}&access_token=${userToken}&v=5.251`
        )
      ).json();
      if (check?.error) {
        return `Токен админа не подходит для загрузки фото (${check.error.error_msg}). Получите токен с правами wall+photos на vkhost.github.io (Kate Mobile) аккаунтом-админом сообщества, или оставьте поле пустым.`;
      }
    }

    return {
      id: `-${group.id}`,
      name: group.name,
      accessToken: token,
      // ключи сообщества не протухают и не ротируются
      refreshToken: token,
      expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      picture: group.photo_200 || '',
      username: group.screen_name || String(group.id),
    };
  }

  override async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  // Достаём опциональный токен админа из сохранённых полей формы
  private userTokenFrom(integration?: Integration): string | null {
    try {
      const details = JSON.parse(
        AuthService.fixedDecryption(integration!.customInstanceDetails!)
      );
      const token = String(details.userToken || '').trim();
      return token || null;
    } catch (err) {
      return null;
    }
  }

  // Официальная цепочка загрузки фото на стену сообщества — только
  // пользовательским токеном админа: getWallUploadServer(group_id) →
  // upload → saveWallPhoto(group_id). Фото становится собственностью
  // сообщества (owner_id=-gid) и без проблем крепится к wall.post
  // ключом сообщества. Файл буферизуем (Content-Length) и ретраим:
  // загрузчик VK иногда отвечает пусто на первый запрос.
  private async uploadViaUserToken(
    gid: string,
    userToken: string,
    post: PostDetails
  ): Promise<{ id: string; type: string; owner: string }[]> {
    const result: { id: string; type: string; owner: string }[] = [];

    for (const item of post?.media || []) {
      const { data: fileBuffer } = await this.getSsrfSafeAxios().get(
        item.path!,
        { responseType: 'arraybuffer' }
      );
      const fileName = item.path.split('/').at(-1) || 'photo.jpg';
      const isVideo = hasExtension(item.path, 'mp4');

      let saved: any = null;
      let lastAnswer = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const server = await (
          await this.fetch(
            isVideo
              ? `https://api.vk.com/method/video.save?group_id=${gid}&access_token=${userToken}&v=5.251`
              : `https://api.vk.com/method/photos.getWallUploadServer?group_id=${gid}&access_token=${userToken}&v=5.251`
          )
        ).json();

        if (server?.error) {
          lastAnswer = JSON.stringify(server.error);
          break;
        }

        const formData = new FormDataNew();
        formData.append(isVideo ? 'video_file' : 'photo', Buffer.from(fileBuffer), {
          filename: fileName,
          knownLength: (fileBuffer as Buffer).length,
        });

        const uploaded = (
          await this.getSsrfSafeAxios().post(
            server.response.upload_url,
            formData,
            { headers: { ...formData.getHeaders() } }
          )
        ).data;

        if (isVideo) {
          if (uploaded?.video_id || server.response.video_id) {
            saved = {
              id: uploaded?.video_id || server.response.video_id,
              owner_id: server.response.owner_id || `-${gid}`,
              type: 'video',
            };
            break;
          }
          lastAnswer = JSON.stringify(uploaded || {});
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        if (!uploaded?.photo || uploaded.photo === '[]') {
          lastAnswer = JSON.stringify(uploaded || {});
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        const formSend = new FormData();
        formSend.append('photo', uploaded.photo);
        formSend.append('server', String(uploaded.server));
        formSend.append('hash', uploaded.hash);
        formSend.append('group_id', gid);

        const answer = await (
          await this.fetch(
            `https://api.vk.com/method/photos.saveWallPhoto?access_token=${userToken}&v=5.251`,
            { method: 'POST', body: formSend }
          )
        ).json();

        if (answer?.response?.[0]?.id) {
          saved = { ...answer.response[0], type: 'photo' };
          break;
        }
        lastAnswer = JSON.stringify(answer || {});
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      if (!saved) {
        throw new BadBody(
          this.identifier,
          lastAnswer,
          {} as any,
          `VK не принял файл ${fileName}: ${lastAnswer.slice(0, 200)}`
        );
      }

      result.push({
        id: String(saved.id),
        type: saved.type,
        owner: String(saved.owner_id),
      });
    }

    return result;
  }

  override async post(
    userId: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration?: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const gid = String(userId).replace(/^-/, '');

    let mediaList: { id: string; type: string; owner: string }[] = [];
    if (firstPost?.media?.length) {
      const userToken = this.userTokenFrom(integration);
      if (!userToken) {
        throw new BadBody(
          this.identifier,
          '{}',
          {} as any,
          'VK не разрешает ключам сообществ загружать медиа. Переподключите канал «VK Сообщество» и заполните поле «Токен админа» (vkhost.github.io), либо публикуйте без медиа.'
        );
      }
      mediaList = await this.uploadViaUserToken(gid, userToken, firstPost);
    }

    const body = new FormData();
    body.append('message', firstPost.message || '');
    body.append('owner_id', `-${gid}`);
    body.append('from_group', '1');
    if (mediaList.length) {
      body.append(
        'attachments',
        mediaList.map((p) => `${p.type}${p.owner}_${p.id}`).join(',')
      );
    }

    const { response, error } = await (
      await this.fetch(
        `https://api.vk.com/method/wall.post?v=5.251&access_token=${accessToken}`,
        { method: 'POST', body }
      )
    ).json();

    if (error || !response?.post_id) {
      throw new BadBody(
        this.identifier,
        JSON.stringify(error || {}),
        {} as any,
        `VK не опубликовал пост: ${error?.error_msg || 'нет post_id в ответе'}`
      );
    }

    return [
      {
        id: firstPost.id,
        postId: String(response.post_id),
        releaseURL: `https://vk.com/wall-${gid}_${response.post_id}`,
        status: 'completed',
      },
    ];
  }

  // Наследуемый comment() зовёт uploadMedia без integration — токена админа
  // там не достать, поэтому медиа в комментариях явно запрещаем.
  protected override async uploadMedia(
    userId: string,
    accessToken: string,
    post: PostDetails
  ): Promise<{ id: string; type: string; owner: string }[]> {
    if (post?.media?.length) {
      throw new BadBody(
        this.identifier,
        '{}',
        {} as any,
        'Медиа в комментариях от имени сообщества VK не поддерживается — уберите вложения из комментария'
      );
    }
    return [];
  }
}
