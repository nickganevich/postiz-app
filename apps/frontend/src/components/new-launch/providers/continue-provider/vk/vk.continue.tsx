'use client';

import { withContinueProvider } from '../with-continue-provider';

interface VkTarget {
  id: string;
  name: string;
  picture: { data: { url: string } };
}

export const VkContinue = withContinueProvider<VkTarget, string>({
  endpoint: 'pages',
  swrKey: 'load-vk-targets',
  titleKey: 'select_vk_target',
  titleDefault: 'Куда публиковать:',
  emptyStateMessages: [
    {
      key: 'we_couldn_t_find_any_vk_targets',
      text: 'Не нашли ни личную страницу, ни сообщества.',
    },
    {
      key: 'vk_group_admin_hint',
      text: 'Для публикации в сообщество нужны права администратора или редактора.',
    },
  ],
  getItemId: (item) => item.id,
  getSelectionValue: (item) => item.id,
  transformSaveData: (selection) => ({ page: selection }),
  isSelected: (item, selection) => selection === item.id,
  renderItem: (item) => (
    <>
      <div>
        <img className="w-full" src={item.picture?.data?.url} alt={item.name} />
      </div>
      <div>{item.name}</div>
    </>
  ),
});
