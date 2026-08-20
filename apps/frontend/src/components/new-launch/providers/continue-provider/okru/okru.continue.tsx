'use client';

import { withContinueProvider } from '../with-continue-provider';

interface OkruGroup {
  id: string;
  name: string;
  picture: string;
}

export const OkruContinue = withContinueProvider<OkruGroup, string>({
  endpoint: 'pages',
  swrKey: 'load-okru-groups',
  titleKey: 'select_group',
  titleDefault: 'Выберите группу:',
  emptyStateMessages: [
    {
      key: 'we_couldn_t_find_any_okru_groups',
      text: 'Не нашли ни одной группы, где вы можете публиковать.',
    },
    {
      key: 'okru_group_admin_hint',
      text: 'Нужны права администратора или модератора группы, а приложению — доступ к методу mediatopic.post.',
    },
  ],
  getItemId: (item) => item.id,
  getSelectionValue: (item) => item.id,
  transformSaveData: (selection) => ({ group: selection }),
  isSelected: (item, selection) => selection === item.id,
  renderItem: (item) => (
    <>
      <div>
        <img className="w-full" src={item.picture} alt={item.name} />
      </div>
      <div>{item.name}</div>
    </>
  ),
});
