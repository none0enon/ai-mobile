import { defineStore } from 'pinia';
import { ref } from 'vue';
import { autoSave, getEntries, getOne, write } from '@/db/idb';
import type { Book } from '@/services/books';

/**
 * 我们的书架：一起看书的书都存在本机（books 表，一本一条；PDF 原文件另存一条 file:{id}，扫描页交给识图时要用）。
 * 书不进同步数据，也不上传。
 */
export const useBookStore = defineStore('books', () => {
  const books = ref<Book[]>([]);
  const saver = autoSave('books', () => books.value.map((b) => ({ key: b.id, value: b })), books);

  async function hydrate() {
    const rows = await getEntries<Book>('books');
    books.value = rows.filter((r) => !r.key.startsWith('file:') && r.value && Array.isArray(r.value.chapters)).map((r) => r.value).sort((a, b) => b.updatedAt - a.updatedAt);
    saver.start();
  }

  function byId(id: string | null | undefined): Book | undefined {
    return books.value.find((b) => b.id === id);
  }

  function add(book: Book, file?: Blob) {
    books.value.unshift(book);
    if (file) void write('books', [{ key: `file:${book.id}`, value: file }]);
  }

  function remove(id: string) {
    books.value = books.value.filter((b) => b.id !== id);
    void write('books', [], [id, `file:${id}`]);
  }

  async function fileOf(id: string): Promise<Blob | undefined> {
    return getOne<Blob>('books', `file:${id}`);
  }

  return { books, hydrate, byId, add, remove, fileOf };
});
