import React from 'react';
import { Pencil, Plus, X } from 'lucide-react';

interface Props {
  /** Courses on the area; empty = one course so far (only "+ трасса" is offered) */
  courses: { id: string; name: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Course editing: add / rename / remove (left out in the splits panel) */
  onAdd?: () => void;
  onRename?: (id: string) => void;
  onRemove?: (id: string) => void;
}

/** Course switcher: A | B | C (+ add, rename, remove while marking the course) */
export const CourseTabs: React.FC<Props> = ({
  courses,
  activeId,
  onSelect,
  onAdd,
  onRename,
  onRemove,
}) => (
  <div className="flex items-center gap-1 flex-wrap">
    {courses.length > 0 && <span className="text-slate-400">Трасса</span>}
    {courses.map((c) => {
      const active = c.id === activeId;
      return (
        <span
          key={c.id}
          className={`inline-flex items-center rounded border transition ${
            active
              ? 'bg-fuchsia-600 border-fuchsia-400 text-white'
              : 'bg-slate-900 border-slate-700 text-fuchsia-200 hover:text-white'
          }`}
        >
          <button
            onClick={() => onSelect(c.id)}
            className="px-2 py-0.5 font-semibold"
            title={`Показать трассу ${c.name}: её КП, сплиты и перегоны`}
          >
            {c.name}
          </button>
          {active && onRename && (
            <button
              onClick={() => onRename(c.id)}
              className="pr-1 opacity-70 hover:opacity-100"
              title="Переименовать трассу"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
          {active && onRemove && courses.length > 1 && (
            <button
              onClick={() => onRemove(c.id)}
              className="pr-1 opacity-70 hover:opacity-100"
              title="Удалить трассу"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </span>
      );
    })}
    {onAdd && (
      <button
        onClick={onAdd}
        className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded border border-dashed border-fuchsia-500/60 text-fuchsia-200 hover:text-white"
        title="Ещё одна трасса на этом участке (A, B, C…): старт и финиш общие, КП свои — можно брать и КП других трасс"
      >
        <Plus className="w-3 h-3" />
        {courses.length === 0 ? 'Ещё трасса (B)' : 'Трасса'}
      </button>
    )}
  </div>
);
