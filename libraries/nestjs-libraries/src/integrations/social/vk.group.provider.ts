import { Integration } from '@prisma/client';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { VkProvider } from '@gitroom/nestjs-libraries/integrations/social/vk.provider';

// Канал «VK Сообщество»: публикация на стену сообщества с медиа.
//
// У VK для этого нужны два разных ключа, и ни один не закрывает задачу
// в одиночку:
//   * ключ доступа сообщества (Управление → Работа с API) умеет wall.post
//     от имени сообщества, но загрузчики медиа для него закрыты —
//     photos.getWallUploadServer и video.save в схеме VK API объявлены
//     как access_token_type: ["user"] (ошибка 27 "Group authorization failed");
//   * пользовательский токен админа умеет грузить фото и видео в сообщество,
//     но wall.post с owner_id=-gid отдаёт 1051 "method is unavailable with
//     current profile type".
//
// Поэтому канал подключается входом админа через VK ID (его токен Postiz
// сам обновляет по refresh_token) и грузит им медиа, а ключ сообщества
// лежит в настройках канала и используется только для самой записи.
export class VkGroupProvider extends VkProvider {
  override identifier = 'vk-group';
  override name = 'VK Сообщество';

  // Канал сообщества — только сообщества: личную страницу из списка убираем,
  // для неё есть обычный канал «VK».
  override async pages(accessToken: string) {
    const pages = await super.pages(accessToken);
    return pages.filter((page) => String(page.id).startsWith('-'));
  }

  // Ключ сообщества: сначала настройки канала, затем — форма подключения
  // каналов, заведённых до перехода на VK ID (там он лежал как accessToken).
  protected override communityKey(integration?: Integration): string | null {
    const fromSettings = super.communityKey(integration);
    if (fromSettings) {
      return fromSettings;
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

  protected override mediaTokenHint(): string {
    return 'Переподключите канал «VK Сообщество» — вход админом сообщества через VK ID.';
  }
}
