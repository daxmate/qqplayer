// sortablejs 最小类型声明（包本身无 @types；只覆盖 Playlist 用到的 API）
declare module "sortablejs" {
  interface SortableEvent {
    oldIndex?: number;
    newIndex?: number;
  }
  interface SortableOptions {
    handle?: string;
    animation?: number;
    ghostClass?: string;
    supportPointer?: boolean;
    onEnd?: (evt: SortableEvent) => void;
  }
  interface Sortable {
    destroy(): void;
  }
  const Sortable: {
    create(el: HTMLElement, options?: SortableOptions): Sortable;
  };
  export default Sortable;
}
