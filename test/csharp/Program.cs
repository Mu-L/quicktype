﻿using System;
using System.IO;

namespace test
{
    class Program
    {
        static void Main(string[] args)
        {
            var path = args[0];
            var json = File.ReadAllText(path);
            var qt = QuickType.Converter.FromJson(json);
        }
    }
}