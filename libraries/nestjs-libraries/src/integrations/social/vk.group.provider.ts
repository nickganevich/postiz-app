import {
  AuthTokenDetails,
  PostDetails,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
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
    let body: { group?: string; accessToken?: string };
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

  // Ключу сообщества недоступны все photos.get*UploadServer для стены
  // (error 27) — единственный разрешённый загрузчик у сообществ это
  // "загрузка для сообщений" (так работают боты). Такое фото отлично
  // прикладывается к wall.post как photo{owner}_{id}_{access_key}.
  // Важно: filename с расширением обязателен, иначе VK молча вернёт
  // пустое поле photo. Видео ключом сообщества загрузить нельзя вовсе.
  protected override async uploadMedia(
    userId: string,
    accessToken: string,
    post: PostDetails
  ): Promise<{ id: string; type: string; owner: string }[]> {
    const media = post?.media || [];
    if (media.some((item) => hasExtension(item.path, 'mp4'))) {
      throw new BadBody(
        this.identifier,
        '{}',
        {} as any,
        'VK не разрешает загружать видео ключом сообщества — прикрепите фото или уберите видео'
      );
    }

    const result: { id: string; type: string; owner: string }[] = [];
    for (const item of media) {
      // Файл качаем целиком в буфер: при потоковой (chunked) передаче
      // pu.vk.com периодически отвечает пустым полем photo. С буфером
      // form-data проставляет Content-Length, и загрузка стабильна.
      const { data: fileBuffer } = await this.getSsrfSafeAxios().get(
        item.path!,
        { responseType: 'arraybuffer' }
      );
      const fileName = item.path.split('/').at(-1) || 'photo.jpg';

      let saved: any = null;
      let lastAnswer = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const server = await (
          await this.fetch(
            `https://api.vk.com/method/photos.getMessagesUploadServer?peer_id=0&access_token=${accessToken}&v=5.251`
          )
        ).json();

        const formData = new FormDataNew();
        formData.append('photo', Buffer.from(fileBuffer), {
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

        if (!uploaded?.photo || uploaded.photo === '[]') {
          // upload_url одноразовый — на следующий круг берём свежий
          lastAnswer = JSON.stringify(uploaded || {});
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        const formSend = new FormData();
        formSend.append('photo', uploaded.photo);
        formSend.append('server', String(uploaded.server));
        formSend.append('hash', uploaded.hash);

        const answer = await (
          await this.fetch(
            `https://api.vk.com/method/photos.saveMessagesPhoto?access_token=${accessToken}&v=5.251`,
            { method: 'POST', body: formSend }
          )
        ).json();

        if (answer?.response?.[0]?.id) {
          saved = answer.response[0];
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
          `VK не принял фото ${fileName} после трёх попыток — попробуйте ещё раз или замените изображение`
        );
      }

      result.push({
        id: saved.access_key ? `${saved.id}_${saved.access_key}` : String(saved.id),
        type: 'photo',
        owner: String(saved.owner_id),
      });
    }

    return result;
  }
}
