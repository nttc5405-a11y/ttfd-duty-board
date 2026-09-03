# -*- coding: utf-8 -*-
"""
把 collector.js（或其他可讀版腳本）壓成一行的書籤字串。

注意：不要用正則 /\*.*?\*/ 移除區塊註解 —— 程式碼字串裡若出現 "*/"
（例如 Accept 標頭的 */*），會被誤判成註解結尾，把中間整段程式碼吃掉。
這裡改為逐行判斷：只有「行首」是 /* 才算註解開始。

用法：
    python collector/build.py collector/collector.js collector/_min.txt
"""

import sys
import re
import io


def minify(src: str) -> str:
    out = []
    in_block = False

    for line in src.split("\n"):
        s = line.strip()

        if in_block:
            if "*/" in s:
                in_block = False
            continue

        if s.startswith("/*"):
            if "*/" not in s:
                in_block = True
            continue

        if s.startswith("//") or not s:
            continue

        out.append(s)

    joined = " ".join(out)
    # 只壓縮「行與行之間」多餘的空白，字串內的單一空白不受影響
    joined = re.sub(r"[ \t]{2,}", " ", joined)
    return joined


def main():
    if len(sys.argv) < 3:
        print("用法：python build.py <來源.js> <輸出.txt>")
        return 1

    src_path, out_path = sys.argv[1], sys.argv[2]

    with io.open(src_path, encoding="utf-8") as f:
        src = f.read()

    code = minify(src)

    # 基本檢查：括號與引號是否平衡
    problems = []
    for a, b, label in [("(", ")", "小括號"), ("{", "}", "大括號"), ("[", "]", "中括號")]:
        if code.count(a) != code.count(b):
            problems.append("%s 不平衡（%d vs %d）" % (label, code.count(a), code.count(b)))
    if code.count('"') % 2:
        problems.append("雙引號數量為奇數")

    with io.open(out_path, "w", encoding="utf-8") as f:
        f.write("javascript:" + code)

    print("輸出：%s" % out_path)
    print("長度：%d 字元" % len(code))
    if problems:
        print("警告：" + "；".join(problems))
    else:
        print("括號與引號檢查：通過")
    return 0


if __name__ == "__main__":
    sys.exit(main())
